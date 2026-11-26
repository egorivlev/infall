//! `AiEvent` (what the web UI receives) and the mapping from Claude Code's `stream-json` lines.
//!
//! The shape of that stream is not specified by `claude --help`, and this code was written
//! without a real run to check it against (see desktop/README.md, "Unverified against a real
//! run"). The parser is therefore defensive: a line that is not JSON, or has a `type` it does
//! not know, is ignored; nothing here can fail.

use serde::Serialize;
use serde_json::Value;

/// The events of docs/specs/desktop.md, serialised exactly as the web UI's `AiEvent` type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AiEvent {
    /// More of the answer.
    Delta { text: String },
    /// The model is calling a Infall tool; the bare tool name (`list_cards`, not `mcp__infall__list_cards`).
    Tool { name: String },
    /// The run is complete.
    Done {
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        /// Claude Code's session id, to resume with.
        #[serde(skip_serializing_if = "Option::is_none")]
        session: Option<String>,
    },
    /// The run failed; a plain sentence.
    Error { message: String },
}

impl AiEvent {
    /// `done` and `error` end a run.
    pub fn is_terminal(&self) -> bool {
        matches!(self, AiEvent::Done { .. } | AiEvent::Error { .. })
    }
}

/// The prefix Claude Code gives the tools of the MCP server named `infall`.
pub const TOOL_PREFIX: &str = "mcp__infall__";

const MAX_ERROR_CHARS: usize = 400;

/// Turns `stream-json` lines into `AiEvent`s. Feed it one line at a time.
#[derive(Debug, Default)]
pub struct StreamParser {
    model: Option<String>,
    session: Option<String>,
    /// A partial-message (`stream_event`) line was seen: complete `assistant` messages then
    /// repeat what was already streamed and are not mapped again.
    partials: bool,
    /// Some answer text has been emitted.
    any_text: bool,
    /// A new text block began after earlier text: separate them with a blank line.
    separator_due: bool,
    finished: bool,
}

impl StreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// A `done` or `error` has been produced; later lines are ignored.
    pub fn finished(&self) -> bool {
        self.finished
    }

    /// Maps one line of output. Never fails: unknown or malformed lines give no events.
    pub fn feed(&mut self, line: &str) -> Vec<AiEvent> {
        let mut out = Vec::new();
        if self.finished {
            return out;
        }
        let line = line.trim();
        if !line.starts_with('{') {
            return out;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return out;
        };
        if let Some(id) = str_at(&v, "session_id") {
            self.session = Some(id.to_owned());
        }
        match str_at(&v, "type") {
            Some("system") => {
                if let Some(model) = str_at(&v, "model") {
                    self.model = Some(model.to_owned());
                }
            }
            Some("stream_event") => {
                // Sub-agents are switched off; if one ever spoke, its text is not the answer.
                if v.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
                    return out;
                }
                self.partials = true;
                if let Some(event) = v.get("event") {
                    self.stream_event(event, &mut out);
                }
            }
            Some("assistant") => {
                if v.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
                    return out;
                }
                let message = v.get("message").unwrap_or(&Value::Null);
                if let Some(model) = str_at(message, "model") {
                    self.model = Some(model.to_owned());
                }
                if !self.partials {
                    for block in message
                        .get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        match str_at(block, "type") {
                            Some("text") => {
                                if self.any_text {
                                    self.separator_due = true;
                                }
                                self.text(str_at(block, "text").unwrap_or(""), &mut out);
                            }
                            Some(kind) if is_tool_use(kind) => self.tool(block, &mut out),
                            _ => {}
                        }
                    }
                }
            }
            Some("result") => {
                self.finished = true;
                let subtype = str_at(&v, "subtype");
                let failed = v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
                    || subtype.is_some_and(|s| s != "success");
                if failed {
                    out.push(AiEvent::Error {
                        message: result_error(&v, subtype),
                    });
                } else {
                    // If the answer never arrived as deltas or messages, the result carries it.
                    if !self.any_text
                        && let Some(text) = str_at(&v, "result")
                    {
                        self.text(text, &mut out);
                    }
                    out.push(AiEvent::Done {
                        model: self.model.clone(),
                        session: self.session.clone(),
                    });
                }
            }
            _ => {}
        }
        out
    }

    fn stream_event(&mut self, event: &Value, out: &mut Vec<AiEvent>) {
        match str_at(event, "type") {
            Some("message_start") => {
                if let Some(model) = event.get("message").and_then(|m| str_at(m, "model")) {
                    self.model = Some(model.to_owned());
                }
            }
            Some("content_block_start") => {
                let block = event.get("content_block").unwrap_or(&Value::Null);
                match str_at(block, "type") {
                    Some("text") => {
                        if self.any_text {
                            self.separator_due = true;
                        }
                        self.text(str_at(block, "text").unwrap_or(""), out);
                    }
                    Some(kind) if is_tool_use(kind) => self.tool(block, out),
                    _ => {}
                }
            }
            Some("content_block_delta") => {
                let delta = event.get("delta").unwrap_or(&Value::Null);
                if str_at(delta, "type") == Some("text_delta") {
                    self.text(str_at(delta, "text").unwrap_or(""), out);
                }
            }
            _ => {}
        }
    }

    fn text(&mut self, text: &str, out: &mut Vec<AiEvent>) {
        if text.is_empty() {
            return;
        }
        let mut text = text.to_owned();
        if self.separator_due {
            self.separator_due = false;
            text.insert_str(0, "\n\n");
        }
        self.any_text = true;
        out.push(AiEvent::Delta { text });
    }

    fn tool(&mut self, block: &Value, out: &mut Vec<AiEvent>) {
        if let Some(name) = str_at(block, "name") {
            let bare = name.strip_prefix(TOOL_PREFIX).unwrap_or(name);
            if !bare.is_empty() {
                out.push(AiEvent::Tool {
                    name: bare.to_owned(),
                });
            }
        }
    }
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn is_tool_use(kind: &str) -> bool {
    matches!(kind, "tool_use" | "mcp_tool_use" | "server_tool_use")
}

/// A plain sentence for a failed `result` line: Claude Code's own text if it gave one.
fn result_error(v: &Value, subtype: Option<&str>) -> String {
    let own = str_at(v, "result")
        .map(str::to_owned)
        .or_else(|| {
            v.get("errors").and_then(Value::as_array).map(|errors| {
                errors
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
        })
        .map(|s| one_line(&s))
        .filter(|s| !s.is_empty());
    match (own, subtype) {
        (Some(text), _) => format!("Claude Code reported an error: {text}"),
        (None, Some("error_max_turns")) => {
            "Claude Code stopped: the answer needed too many steps.".to_owned()
        }
        (None, _) => "Claude Code could not finish the answer.".to_owned(),
    }
}

/// Collapses whitespace and control characters, and bounds the length.
pub(crate) fn one_line(s: &str) -> String {
    let mut out = String::new();
    for word in s.split(|c: char| c.is_whitespace() || c.is_control()) {
        if word.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    if out.chars().count() > MAX_ERROR_CHARS {
        out = out.chars().take(MAX_ERROR_CHARS).collect::<String>() + "…";
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn feed_all(lines: &[Value]) -> Vec<AiEvent> {
        let mut p = StreamParser::new();
        lines
            .iter()
            .flat_map(|l| p.feed(&l.to_string()))
            .collect::<Vec<_>>()
    }

    fn delta(text: &str) -> AiEvent {
        AiEvent::Delta { text: text.into() }
    }

    #[test]
    fn serialises_as_the_web_type() {
        let s = |e: AiEvent| serde_json::to_string(&e).unwrap();
        assert_eq!(s(delta("hi")), r#"{"type":"delta","text":"hi"}"#);
        assert_eq!(
            s(AiEvent::Tool {
                name: "get_card".into()
            }),
            r#"{"type":"tool","name":"get_card"}"#
        );
        assert_eq!(
            s(AiEvent::Done {
                model: None,
                session: None
            }),
            r#"{"type":"done"}"#
        );
        assert_eq!(
            s(AiEvent::Done {
                model: Some("m".into()),
                session: Some("s".into())
            }),
            r#"{"type":"done","model":"m","session":"s"}"#
        );
        assert_eq!(
            s(AiEvent::Error {
                message: "No.".into()
            }),
            r#"{"type":"error","message":"No."}"#
        );
    }

    #[test]
    fn partial_messages_map_to_deltas_a_tool_and_done() {
        let events = feed_all(&[
            json!({"type":"system","subtype":"init","session_id":"s-1","model":"claude-x","tools":[]}),
            json!({"type":"stream_event","session_id":"s-1","parent_tool_use_id":null,"event":{"type":"message_start","message":{"model":"claude-x"}}}),
            json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me "}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"look."}}}),
            json!({"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"mcp__infall__list_cards","input":{}}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}}),
            json!({"type":"assistant","message":{"model":"claude-x","content":[{"type":"text","text":"Let me look."},{"type":"tool_use","name":"mcp__infall__list_cards"}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"[]"}]}}),
            json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Nothing yet."}}}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"Nothing yet."}]}}),
            json!({"type":"result","subtype":"success","is_error":false,"result":"Nothing yet.","session_id":"s-1"}),
        ]);
        assert_eq!(
            events,
            vec![
                delta("Let me "),
                delta("look."),
                AiEvent::Tool {
                    name: "list_cards".into()
                },
                delta("\n\nNothing yet."),
                AiEvent::Done {
                    model: Some("claude-x".into()),
                    session: Some("s-1".into())
                },
            ]
        );
    }

    #[test]
    fn without_partials_complete_messages_are_used() {
        let events = feed_all(&[
            json!({"type":"assistant","session_id":"s-2","message":{"model":"m","content":[{"type":"text","text":"One."},{"type":"tool_use","name":"mcp__infall__get_card"}]}}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"Two."}]}}),
            json!({"type":"result","subtype":"success","result":"Two."}),
        ]);
        assert_eq!(
            events,
            vec![
                delta("One."),
                AiEvent::Tool {
                    name: "get_card".into()
                },
                delta("\n\nTwo."),
                AiEvent::Done {
                    model: Some("m".into()),
                    session: Some("s-2".into())
                },
            ]
        );
    }

    #[test]
    fn a_bare_result_still_gives_the_answer() {
        let events = feed_all(&[json!({"type":"result","subtype":"success","result":"Hello."})]);
        assert_eq!(
            events,
            vec![
                delta("Hello."),
                AiEvent::Done {
                    model: None,
                    session: None
                }
            ]
        );
    }

    #[test]
    fn error_results_become_one_plain_sentence() {
        let events = feed_all(&[
            json!({"type":"result","subtype":"success","is_error":true,"result":"Invalid API key\n· Please run /login","session_id":"s"}),
        ]);
        assert_eq!(
            events,
            vec![AiEvent::Error {
                message: "Claude Code reported an error: Invalid API key · Please run /login"
                    .into()
            }]
        );
        let events = feed_all(&[json!({"type":"result","subtype":"error_max_turns"})]);
        assert_eq!(
            events,
            vec![AiEvent::Error {
                message: "Claude Code stopped: the answer needed too many steps.".into()
            }]
        );
        let events = feed_all(&[json!({"type":"result","subtype":"error_during_execution"})]);
        assert_eq!(
            events,
            vec![AiEvent::Error {
                message: "Claude Code could not finish the answer.".into()
            }]
        );
    }

    #[test]
    fn garbage_and_unknown_lines_are_ignored() {
        let mut p = StreamParser::new();
        for line in [
            "",
            "not json",
            "{broken",
            "[1,2,3]",
            "42",
            "null",
            r#"{"no":"type"}"#,
            r#"{"type":"brand_new_event","text":"x"}"#,
            r#"{"type":"stream_event"}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":"text"}}"#,
            r#"{"type":"assistant","message":"text"}"#,
            r#"{"type":"assistant","message":{"content":"text"}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use"}}}"#,
        ] {
            assert_eq!(p.feed(line), vec![], "line: {line}");
        }
        assert!(!p.finished());
    }

    #[test]
    fn sub_agent_text_is_not_the_answer() {
        let events = feed_all(&[
            json!({"type":"stream_event","parent_tool_use_id":"t9","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"inner"}}}),
        ]);
        assert_eq!(events, vec![]);
    }

    #[test]
    fn nothing_is_mapped_after_the_result() {
        let mut p = StreamParser::new();
        assert_eq!(p.feed(r#"{"type":"result","subtype":"success"}"#).len(), 1);
        assert!(p.finished());
        assert_eq!(p.feed(r#"{"type":"result","subtype":"success"}"#), vec![]);
    }

    #[test]
    fn long_errors_are_bounded() {
        let long = "x".repeat(5000);
        let events = feed_all(&[json!({"type":"result","is_error":true,"result":long})]);
        let AiEvent::Error { message } = &events[0] else {
            panic!("expected an error")
        };
        assert!(message.chars().count() < 500);
    }
}
