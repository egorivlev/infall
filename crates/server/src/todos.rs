//! To-dos (contract §11): outside versioning, the same on every Branch, never for Guests.

use axum::Json;
use axum::extract::{Path, State};
use infall_core::MemberId;
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::app::{Shared, blocking};
use crate::auth::MemberOrAdmin;
use crate::error::{ApiError, ApiJson};
use crate::live::Hub;
use crate::store::{TodoCard, TodoRecord};

const MAX_TEXT_CHARS: usize = 500;
const MAX_CARD_TITLE_CHARS: usize = 300;

/// Checks and trims the text of a To-do.
fn clean_text(text: &str) -> Result<String, ApiError> {
    let text = text.trim();
    if text.is_empty()
        || text.chars().count() > MAX_TEXT_CHARS
        || text.chars().any(char::is_control)
    {
        return Err(ApiError::BadRequest(format!(
            "The text of a To-do must be 1 to {MAX_TEXT_CHARS} characters on one line."
        )));
    }
    Ok(text.to_string())
}

/// The pointer to a Card as sent; ids that are not uuids fail as a wrongly shaped body.
#[derive(Deserialize)]
pub struct CardPointer {
    id: Uuid,
    title: String,
    branch: Uuid,
}

fn clean_card(card: CardPointer) -> Result<TodoCard, ApiError> {
    if card.title.chars().count() > MAX_CARD_TITLE_CHARS {
        return Err(ApiError::BadRequest(format!(
            "The Card title of a To-do may be at most {MAX_CARD_TITLE_CHARS} characters."
        )));
    }
    Ok(TodoCard {
        id: card.id,
        title: card.title,
        branch: card.branch,
    })
}

fn parse_id(raw: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| ApiError::NotFound)
}

/// Reads the full list and sends it to every connected Member and Admin. Callers hold
/// `Hub::todo_order`, so lists reach the sockets in the order the changes were made.
pub async fn broadcast(st: &Shared) -> Result<(), ApiError> {
    let todos = blocking(st, |s| s.todos()).await?;
    Hub::broadcast_todos(st, &todos);
    Ok(())
}

pub async fn list_todos(
    State(st): State<Shared>,
    MemberOrAdmin(_): MemberOrAdmin,
) -> Result<Json<Value>, ApiError> {
    let todos = blocking(&st, |s| s.todos()).await?;
    Ok(Json(json!({ "todos": todos })))
}

#[derive(Deserialize)]
pub struct CreateTodo {
    owner: String,
    text: String,
    card: Option<CardPointer>,
}

pub async fn create_todo(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    ApiJson(body): ApiJson<CreateTodo>,
) -> Result<Json<Value>, ApiError> {
    const BAD_OWNER: &str = "The owner of a To-do must be a Member or an Admin.";
    let text = clean_text(&body.text)?;
    let card = body.card.map(clean_card).transpose()?;
    let owner = Uuid::parse_str(&body.owner)
        .map(MemberId)
        .map_err(|_| ApiError::BadRequest(BAD_OWNER.to_string()))?;
    let todo = TodoRecord {
        id: Uuid::new_v4(),
        owner,
        text,
        done: false,
        done_at: None,
        created_by: who.id(),
        created_at: st.clock.now(),
        card,
    };
    let _order = st.hub.todo_order.lock().await;
    let stored = blocking(&st, {
        let todo = todo.clone();
        move |s| s.insert_todo(&todo)
    })
    .await?;
    if !stored {
        return Err(ApiError::BadRequest(BAD_OWNER.to_string()));
    }
    broadcast(&st).await?;
    Ok(Json(json!({ "todo": todo })))
}

/// Tells an absent field from an explicit `null`.
fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
pub struct PatchTodo {
    text: Option<String>,
    done: Option<bool>,
    /// `Some(None)` clears the pointer.
    #[serde(default, deserialize_with = "present")]
    card: Option<Option<CardPointer>>,
}

pub async fn patch_todo(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<PatchTodo>,
) -> Result<Json<Value>, ApiError> {
    let id = parse_id(&id)?;
    // Held from the read to the broadcast, so the rules are checked against what is
    // then changed.
    let _order = st.hub.todo_order.lock().await;
    let mut todo = blocking(&st, move |s| s.todo(id))
        .await?
        .ok_or(ApiError::NotFound)?;
    let is_owner = todo.owner == who.id();
    if !is_owner && todo.created_by != who.id() {
        return Err(ApiError::Forbidden(
            "Only its owner or whoever added it can change a To-do.",
        ));
    }
    if body.done.is_some() && !is_owner {
        return Err(ApiError::Forbidden(
            "Only its owner can tick or untick a To-do.",
        ));
    }
    let before = todo.clone();
    if let Some(text) = &body.text {
        todo.text = clean_text(text)?;
    }
    if let Some(card) = body.card {
        todo.card = card.map(clean_card).transpose()?;
    }
    if let Some(done) = body.done
        && done != todo.done
    {
        todo.done = done;
        todo.done_at = done.then(|| st.clock.now());
    }
    if todo != before {
        let stored = blocking(&st, {
            let todo = todo.clone();
            move |s| s.update_todo(&todo)
        })
        .await?;
        if !stored {
            return Err(ApiError::NotFound);
        }
        broadcast(&st).await?;
    }
    Ok(Json(json!({ "todo": todo })))
}

pub async fn delete_todo(
    State(st): State<Shared>,
    MemberOrAdmin(who): MemberOrAdmin,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let id = parse_id(&id)?;
    let _order = st.hub.todo_order.lock().await;
    let todo = blocking(&st, move |s| s.todo(id))
        .await?
        .ok_or(ApiError::NotFound)?;
    if todo.owner != who.id() && todo.created_by != who.id() {
        return Err(ApiError::Forbidden(
            "Only its owner or whoever added it can delete a To-do.",
        ));
    }
    if !blocking(&st, move |s| s.delete_todo(id)).await? {
        return Err(ApiError::NotFound);
    }
    broadcast(&st).await?;
    Ok(Json(json!({})))
}
