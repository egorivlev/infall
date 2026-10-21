//! What each Preset puts into a new Local Workspace (docs/specs/local.md, "What each Preset
//! seeds"). Everything goes through the same core operations and the same checks as a
//! Member's own edits, recorded under the one Member, so the Changes, the history and the
//! Checkpoint are ordinary ones.

use qoop_core::{BranchId, EntityId, EntityKind, Fields, MemberId, Moment, Op, Value, Workspace};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::boards::CheckedOps;
use crate::local::Preset;
use crate::store::{
    SuggestedConnection, SuggestionKind, SuggestionRecord, SuggestionState, TodoCard, TodoRecord,
};

/// The names the web UI's Tutorial finds things by. They are constants on both sides.
pub mod names {
    pub const START_HERE: &str = "Start here";
    pub const PAPERS: &str = "Papers";
    pub const EXPERIMENTS: &str = "Experiments";
    pub const WELCOME: &str = "Welcome to Infall";
    pub const RANDOM_WALK: &str = "Random walk experiment";
    pub const WATCH_A_WALK: &str = "Watch a walk";
    pub const TODO: &str = "Read the welcome Card";
    pub const CHECKPOINT: &str = "Before the tutorial";
    pub const BRANCH: &str = "longer-walks";
    pub const LONGER_WALKS: &str = "Walks of 10 000 steps";
}

const RANDOM_WALK_CODE: &str = include_str!("random_walk.py");
const RANDOM_WALK_OUTPUT: &str = include_str!("random_walk.out");
const ESTIMATE_PI_CODE: &str = include_str!("estimate_pi.py");
const ESTIMATE_PI_OUTPUT: &str = include_str!("estimate_pi.out");
const WATCH_A_WALK_VISUAL: &str = include_str!("watch_a_walk.html");

/// Where the captured outputs above were produced, and how long each took.
const PYTHON: &str = "3.12.13";
const CAPTURED_ON: (&str, &str) = ("macos", "arm64");
const RANDOM_WALK_MS: u64 = 460;
const ESTIMATE_PI_MS: u64 = 180;

/// How far apart in time the seeded Changes are recorded.
const STEP_MS: i64 = 1000;

/// What a Preset adds outside the Board: those live in their own tables.
#[derive(Default)]
pub struct Seeded {
    pub todos: Vec<TodoRecord>,
    pub suggestions: Vec<SuggestionRecord>,
}

/// Adds the Research Content of `preset` to `ws`, whose `main` must still be empty, as
/// Changes by `member` from `now` on.
pub fn seed(
    preset: Preset,
    ws: &mut Workspace,
    member: MemberId,
    now: i64,
) -> Result<Seeded, String> {
    let main = ws
        .branch_by_name("main")
        .map(|b| b.id())
        .ok_or("the Workspace has no main Branch")?;
    let mut s = Seeder {
        ws,
        member,
        at: now,
    };
    match preset {
        Preset::Blank => Ok(Seeded::default()),
        Preset::LiteratureReview => literature_review(&mut s, main),
        Preset::ResearchProject => research_project(&mut s, main),
        Preset::Tutorial => tutorial(&mut s, main),
    }
}

struct Seeder<'a> {
    ws: &'a mut Workspace,
    member: MemberId,
    at: i64,
}

impl Seeder<'_> {
    /// Records `ops` on `branch` as one edit by the Member, after the checks a Member's own
    /// `POST …/ops` goes through.
    fn record(&mut self, branch: BranchId, ops: Vec<Op>) -> Result<Moment, String> {
        let checked = CheckedOps::new(ops, self.member).map_err(|e| e.to_string())?;
        let head = self.ws.head(branch).map_err(|e| e.to_string())?;
        let ops = checked.on_board(self.ws, head).map_err(|e| e.to_string())?;
        let at = self.tick();
        self.ws
            .record_all(branch, self.member, at, ops)
            .map_err(|e| e.to_string())
    }

    fn tick(&mut self) -> i64 {
        self.at += STEP_MS;
        self.at
    }

    /// The captured output of a Run, as the Runner records it (api.md §15).
    fn run_result(&mut self, code: &str, output: &str, duration_ms: u64) -> String {
        let sha: String = Sha256::digest(code.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        json!({
            "v": 1,
            "by": self.member.0.to_string(),
            "at": self.at,
            "code_sha256": sha,
            "exit": 0,
            "duration_ms": duration_ms,
            "output": output,
            "figures": [],
            "env": { "python": PYTHON, "os": CAPTURED_ON.0, "arch": CAPTURED_ON.1 },
        })
        .to_string()
    }
}

// ---------------------------------------------------------------- op builders

fn text(s: &str) -> Value {
    Value::Text(s.to_string())
}

fn create(entity: EntityId, kind: EntityKind, fields: Vec<(&str, Value)>) -> Op {
    let fields: Fields = fields
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    Op::Create {
        entity,
        kind,
        fields,
    }
}

fn frame(id: EntityId, title: &str, (x, y, w, h): (f64, f64, f64, f64)) -> Op {
    create(
        id,
        EntityKind::Frame,
        vec![
            ("title", text(title)),
            ("x", Value::Float(x)),
            ("y", Value::Float(y)),
            ("w", Value::Float(w)),
            ("h", Value::Float(h)),
        ],
    )
}

fn card(id: EntityId, (x, y): (f64, f64), title: &str, status: &str, summary: &str) -> Op {
    create(
        id,
        EntityKind::Card,
        vec![
            ("title", text(title)),
            ("status", text(status)),
            ("summary", text(summary)),
            ("x", Value::Float(x)),
            ("y", Value::Float(y)),
        ],
    )
}

fn connection(from: EntityId, to: EntityId, kind: &str, label: Option<&str>) -> Op {
    let mut fields = vec![
        ("from", Value::Ref(from)),
        ("to", Value::Ref(to)),
        ("kind", text(kind)),
    ];
    if let Some(label) = label {
        fields.push(("label", text(label)));
    }
    create(EntityId::new(), EntityKind::Connection, fields)
}

/// A Block of `card`'s Page. `order` keys sort as plain strings, like the web UI's.
fn block(card: EntityId, order: &str, kind: &str, title: Option<&str>, body: &str) -> Op {
    let mut fields = vec![
        ("card", Value::Ref(card)),
        ("type", text(kind)),
        ("order", text(order)),
        ("text", text(body)),
    ];
    if let Some(title) = title {
        fields.push(("title", text(title)));
    }
    create(EntityId::new(), EntityKind::Block, fields)
}

/// A Source with a DOI, and its Attachment to `card`.
fn source(card: EntityId, title: &str, authors: &str, year: &str, doi: &str) -> [Op; 2] {
    let id = EntityId::new();
    [
        create(
            id,
            EntityKind::Source,
            vec![
                ("title", text(title)),
                ("authors", text(authors)),
                ("year", text(year)),
                ("doi", text(doi)),
            ],
        ),
        create(
            EntityId::new(),
            EntityKind::Attachment,
            vec![("card", Value::Ref(card)), ("source", Value::Ref(id))],
        ),
    ]
}

/// Four Frames side by side, and where the first Card of each sits.
fn four_frames(titles: [&str; 4]) -> ([EntityId; 4], Vec<Op>, [(f64, f64); 4]) {
    let ids = [(); 4].map(|_| EntityId::new());
    let mut ops = Vec::new();
    let mut spots = [(0.0, 0.0); 4];
    for (i, title) in titles.iter().enumerate() {
        let x = i as f64 * 340.0;
        ops.push(frame(ids[i], title, (x, 0.0, 300.0, 260.0)));
        spots[i] = (x + 38.0, 64.0);
    }
    (ids, ops, spots)
}

// ---------------------------------------------------------------- Literature review

fn literature_review(s: &mut Seeder<'_>, main: BranchId) -> Result<Seeded, String> {
    let (_, frames, spot) = four_frames(["To read", "Reading", "Key findings", "Open questions"]);
    s.record(main, frames)?;

    let (found, reading, finding, question) = (
        EntityId::new(),
        EntityId::new(),
        EntityId::new(),
        EntityId::new(),
    );
    s.record(
        main,
        vec![
            card(
                found,
                spot[0],
                "Papers you have found",
                "idea",
                "One Card per paper you mean to read. Move it to Reading when you start it.",
            ),
            card(
                reading,
                spot[1],
                "How to Read a Paper",
                "reading",
                "A paper being read. Its Source is attached; notes go on its Page.",
            ),
            card(
                finding,
                spot[2],
                "One finding per Card",
                "understood",
                "Write the finding as the title, in one sentence, and connect it to the paper it comes from.",
            ),
            card(
                question,
                spot[3],
                "What no paper answers yet",
                "open_question",
                "Questions the reading raised. Some of them may become your own research.",
            ),
        ],
    )?;
    let mut ops = source(
        reading,
        "How to Read a Paper",
        "S. Keshav",
        "2007",
        "10.1145/1273445.1273458",
    )
    .to_vec();
    ops.push(block(
        reading,
        "U",
        "text",
        None,
        "Read in three passes: a five-minute skim, then a closer read of the figures and claims, then a read deep enough to rebuild the work. Write here what each pass found.",
    ));
    ops.push(connection(finding, reading, "directed", Some("comes from")));
    s.record(main, ops)?;
    Ok(Seeded::default())
}

// ---------------------------------------------------------------- Research project

fn research_project(s: &mut Seeder<'_>, main: BranchId) -> Result<Seeded, String> {
    let (_, frames, spot) = four_frames(["Questions", "Hypotheses", "Experiments", "Results"]);
    s.record(main, frames)?;

    let (question, hypothesis, experiment, result) = (
        EntityId::new(),
        EntityId::new(),
        EntityId::new(),
        EntityId::new(),
    );
    s.record(
        main,
        vec![
            card(
                question,
                spot[0],
                "The question",
                "open_question",
                "The one question this project asks, as a sentence. Connect each Hypothesis to it.",
            ),
            card(
                hypothesis,
                spot[1],
                "A Hypothesis",
                "idea",
                "A possible answer to the question that an experiment could prove wrong.",
            ),
            card(
                experiment,
                spot[2],
                "Estimate π by sampling",
                "understood",
                "An example Run: Python with only its standard library, and its captured output. Replace it with your own experiment.",
            ),
            card(
                result,
                spot[3],
                "What the experiment showed",
                "idea",
                "Write the result here and connect it to the Hypothesis it supports or contradicts.",
            ),
        ],
    )?;
    let run = EntityId::new();
    s.record(
        main,
        vec![
            block(
                experiment,
                "U",
                "text",
                None,
                "Points are drawn at random in the unit square; the share that falls inside the quarter circle tends to $\\pi/4$.",
            ),
            create(
                run,
                EntityKind::Block,
                vec![
                    ("card", Value::Ref(experiment)),
                    ("type", text("run")),
                    ("order", text("V")),
                    ("title", text("Estimate π")),
                    ("text", text(ESTIMATE_PI_CODE)),
                ],
            ),
            connection(hypothesis, question, "directed", Some("answers")),
            connection(experiment, hypothesis, "directed", Some("tests")),
            connection(result, experiment, "related", None),
        ],
    )?;
    let result_text = s.run_result(ESTIMATE_PI_CODE, ESTIMATE_PI_OUTPUT, ESTIMATE_PI_MS);
    s.record(
        main,
        vec![Op::Set {
            entity: run,
            field: "result".to_string(),
            value: Value::Text(result_text),
        }],
    )?;
    Ok(Seeded::default())
}

// ---------------------------------------------------------------- Tutorial

/// The summary of `Random walk experiment` where `longer-walks` starts, on `longer-walks`,
/// and on `main` afterwards: the one Conflict of the Merge.
pub const SUMMARY_AT_CHECKPOINT: &str =
    "Walks on a square lattice; prints the mean squared displacement after 10, 100 and 1000 steps.";
pub const SUMMARY_ON_BRANCH: &str =
    "The same walks with 10 000 steps each: does R²/n stay close to 1 for much longer walks?";
pub const SUMMARY_ON_MAIN: &str =
    "The mean squared displacement grows like the number of steps: R²/n stays close to 1.";

const WELCOME_PAGE: &str = "This Workspace is yours to try Infall in. Everything on it is ordinary Research Content: change it, delete it, or make a new Tutorial Workspace from the start screen.

The Board is about random walks. A walker takes $n$ steps of length 1, each in a random direction. Its distance from the start, $R_n$, varies from walk to walk, but on average its square grows like the number of steps:

$$\\langle R_n^2 \\rangle = n$$

The Tutorial asks you to use one part of Infall at a time and moves on once you have.";

const RUN_PAGE: &str = "The Run below simulates 1000 walkers on a square lattice and prints the mean squared displacement $\\langle R^2 \\rangle$ for three walk lengths. If the formula on Welcome to Infall is right, $R^2/n$ should stay close to 1.";

const VISUAL_PAGE: &str =
    "One walk, drawn step by step. Press New walk for another, or change the number of steps.";

fn tutorial(s: &mut Seeder<'_>, main: BranchId) -> Result<Seeded, String> {
    use names::*;
    let (start_here, papers, experiments) = (EntityId::new(), EntityId::new(), EntityId::new());
    s.record(
        main,
        vec![
            frame(start_here, START_HERE, (0.0, 0.0, 320.0, 260.0)),
            frame(papers, PAPERS, (380.0, 0.0, 840.0, 260.0)),
            frame(experiments, EXPERIMENTS, (0.0, 320.0, 880.0, 260.0)),
        ],
    )?;

    let welcome = EntityId::new();
    let (pearson, einstein, polya) = (EntityId::new(), EntityId::new(), EntityId::new());
    let (walk, watch, guess) = (EntityId::new(), EntityId::new(), EntityId::new());
    s.record(
        main,
        vec![
            card(
                welcome,
                (48.0, 64.0),
                WELCOME,
                "understood",
                "What this Workspace is for, and how the Tutorial works. Open it to read its Page.",
            ),
            card(
                pearson,
                (412.0, 64.0),
                "Pearson 1905: the random walk",
                "reading",
                "Pearson named the problem: where is a walker after n steps of the same length in random directions?",
            ),
            card(
                einstein,
                (676.0, 64.0),
                "Einstein 1905: Brownian motion",
                "understood",
                "The mean squared displacement of a particle grows in proportion to time.",
            ),
            card(
                polya,
                (940.0, 64.0),
                "Pólya 1921: walkers come home",
                "understood",
                "On a line or a plane a random walker returns to its start with probability 1; in three dimensions it may never return.",
            ),
            card(walk, (32.0, 384.0), RANDOM_WALK, "reading", SUMMARY_AT_CHECKPOINT),
            card(
                watch,
                (296.0, 384.0),
                WATCH_A_WALK,
                "idea",
                "A Visual: one random walk drawn step by step, in the Page.",
            ),
            card(
                guess,
                (940.0, 320.0),
                "Guess: a walker never comes back",
                "dead_end",
                "Our first guess, before reading Pólya. The Connection says why it is wrong.",
            ),
        ],
    )?;

    let mut ops = Vec::new();
    ops.extend(source(
        pearson,
        "The Problem of the Random Walk",
        "Karl Pearson",
        "1905",
        "10.1038/072294b0",
    ));
    ops.extend(source(
        einstein,
        "Über die von der molekularkinetischen Theorie der Wärme geforderte Bewegung von in ruhenden Flüssigkeiten suspendierten Teilchen",
        "Albert Einstein",
        "1905",
        "10.1002/andp.19053220806",
    ));
    ops.extend(source(
        polya,
        "Über eine Aufgabe der Wahrscheinlichkeitsrechnung betreffend die Irrfahrt im Straßennetz",
        "Georg Pólya",
        "1921",
        "10.1007/BF01458701",
    ));
    s.record(main, ops)?;

    let run = EntityId::new();
    s.record(
        main,
        vec![
            block(welcome, "U", "text", None, WELCOME_PAGE),
            block(walk, "U", "text", None, RUN_PAGE),
            create(
                run,
                EntityKind::Block,
                vec![
                    ("card", Value::Ref(walk)),
                    ("type", text("run")),
                    ("order", text("V")),
                    ("title", text("Mean squared displacement")),
                    ("text", text(RANDOM_WALK_CODE)),
                ],
            ),
            block(watch, "U", "text", None, VISUAL_PAGE),
            block(
                watch,
                "V",
                "visual",
                Some("A random walk"),
                WATCH_A_WALK_VISUAL,
            ),
        ],
    )?;
    let result_text = s.run_result(RANDOM_WALK_CODE, RANDOM_WALK_OUTPUT, RANDOM_WALK_MS);
    s.record(
        main,
        vec![Op::Set {
            entity: run,
            field: "result".to_string(),
            value: Value::Text(result_text),
        }],
    )?;

    s.record(
        main,
        vec![
            connection(welcome, walk, "directed", Some("try it")),
            connection(einstein, walk, "directed", Some("predicts")),
            connection(pearson, einstein, "related", None),
            connection(
                polya,
                guess,
                "contradicts",
                Some("returns with probability 1"),
            ),
            connection(walk, watch, "related", Some("the same walk, drawn")),
        ],
    )?;

    let at = s.tick();
    let suggestion = SuggestionRecord {
        id: Uuid::new_v4(),
        branch: main,
        kind: SuggestionKind::Connection,
        card: None,
        source: None,
        connection: Some(SuggestedConnection {
            from: pearson.0,
            to: polya.0,
            kind: "related".to_string(),
            label: Some("the same walk".to_string()),
        }),
        reason: "Pearson asked where a random walker ends up; Pólya showed whether it comes back. Both are about the same walk.".to_string(),
        created_by: s.member,
        model: None,
        created_at: at,
        state: SuggestionState::Pending,
        decided_by: None,
        decided_at: None,
    };
    let todo = TodoRecord {
        id: Uuid::new_v4(),
        owner: s.member,
        text: TODO.to_string(),
        done: false,
        done_at: None,
        created_by: s.member,
        created_at: at,
        card: Some(TodoCard {
            id: welcome.0,
            title: WELCOME.to_string(),
            branch: main.0,
        }),
    };

    let at = s.tick();
    let checkpoint = s.ws.head(main).map_err(|e| e.to_string())?;
    s.ws.checkpoint(CHECKPOINT, checkpoint, s.member, at)
        .map_err(|e| e.to_string())?;
    let at = s.tick();
    let branch =
        s.ws.fork(BRANCH, checkpoint, s.member, at)
            .map_err(|e| e.to_string())?;
    s.record(
        branch,
        vec![
            Op::Set {
                entity: walk,
                field: "summary".to_string(),
                value: text(SUMMARY_ON_BRANCH),
            },
            card(
                EntityId::new(),
                (560.0, 384.0),
                LONGER_WALKS,
                "idea",
                "Planned: the experiment again with 10 000 steps per walk, and fewer walkers so that it stays quick.",
            ),
        ],
    )?;
    s.record(
        main,
        vec![Op::Set {
            entity: walk,
            field: "summary".to_string(),
            value: text(SUMMARY_ON_MAIN),
        }],
    )?;

    Ok(Seeded {
        todos: vec![todo],
        suggestions: vec![suggestion],
    })
}
