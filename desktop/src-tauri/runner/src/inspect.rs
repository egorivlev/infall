//! What the approval window shows of a Run's code. The title and the code are written by
//! other people: everything here treats them as hostile text.
//!
//! The window never interprets any of it. It gets the code as lines of parts: plain text, or
//! the code point of a character a reader could not see (`U+202E`), which the window draws
//! as a marked box. So the Member sees every character that will be executed.

use serde::Serialize;
use sha2::{Digest, Sha256};

/// A Run's code is a Text field of the server: at most this many characters (api.md).
pub const MAX_CODE_CHARS: usize = 100_000;
/// A title longer than this is cut for display.
pub const MAX_TITLE_CHARS: usize = 200;
/// Lines longer than this get a notice (they are wrapped, never cut).
pub const LONG_LINE_CHARS: usize = 300;

/// SHA-256 of the UTF-8 bytes of `code`, as 64 lowercase hex digits.
pub fn sha256_hex(code: &str) -> String {
    Sha256::digest(code.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Why code is not even shown for approval. A plain sentence for the page.
pub fn check(code: &str) -> Result<(), &'static str> {
    if code.trim().is_empty() {
        return Err("There is no code to run.");
    }
    // Bytes first: a cheap bound, so that an enormous request is not walked twice.
    if code.len() > MAX_CODE_CHARS * 4 || code.chars().count() > MAX_CODE_CHARS {
        return Err("The code is too long to run: a Run holds at most 100 000 characters.");
    }
    Ok(())
}

/// One piece of a line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Part {
    /// Text to show as it is.
    Text { t: String },
    /// A character that cannot be seen or that changes how the text around it is drawn,
    /// named by its code point (`U+202E`).
    Hidden { h: String },
}

/// The code as the approval window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CodeView {
    pub lines: Vec<Vec<Part>>,
    pub line_count: usize,
    pub char_count: usize,
    /// Sentences the window shows above the code, most important first.
    pub notices: Vec<String>,
}

/// Characters that change the direction text is drawn in ("Trojan Source").
fn is_direction_control(c: char) -> bool {
    matches!(
        c as u32,
        0x061C | 0x200E | 0x200F | 0x202A..=0x202E | 0x2066..=0x2069
    )
}

/// Characters a reader cannot see, or cannot tell from an ordinary space or from nothing:
/// control and format characters, unusual spaces, line and paragraph separators, variation
/// selectors, filler letters, private-use and tag characters. Tab is ordinary; the line
/// ends (`\n`, `\r`) never get here.
pub fn is_hidden(c: char) -> bool {
    if c == '\t' {
        return false;
    }
    c.is_control()
        || is_direction_control(c)
        || matches!(
            c as u32,
            0x00A0 | 0x00AD | 0x034F
                | 0x0600..=0x0605 | 0x06DD | 0x070F | 0x0890 | 0x0891 | 0x08E2
                | 0x115F | 0x1160 | 0x1680 | 0x17B4 | 0x17B5 | 0x180B..=0x180F
                | 0x2000..=0x200D | 0x2028 | 0x2029 | 0x202F | 0x205F..=0x2065 | 0x206A..=0x206F
                | 0x2800 | 0x3000 | 0x3164
                | 0xE000..=0xF8FF
                | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF9..=0xFFFB
                | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A
                | 0xE0000..=0xE0FFF | 0xF0000..=0x10FFFF
        )
}

fn code_point(c: char) -> String {
    format!("U+{:04X}", c as u32)
}

/// Splits `code` into lines exactly as Python does (`\n`, `\r\n` and a lone `\r` end a
/// line), so the numbers shown are the numbers a traceback will name.
fn split_lines(code: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let bytes = code.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                lines.push(&code[start..i]);
                start = i + 1;
            }
            b'\r' => {
                lines.push(&code[start..i]);
                if bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if start < bytes.len() {
        lines.push(&code[start..]);
    }
    lines
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// Prepares `code` for the approval window.
pub fn inspect(code: &str) -> CodeView {
    let mut direction = 0usize;
    let mut hidden = 0usize;
    let mut long_lines = 0usize;
    let mut lines = Vec::new();
    for line in split_lines(code) {
        let mut parts = Vec::new();
        let mut text = String::new();
        let mut length = 0usize;
        for c in line.chars() {
            length += 1;
            if is_hidden(c) {
                if is_direction_control(c) {
                    direction += 1;
                } else {
                    hidden += 1;
                }
                if !text.is_empty() {
                    parts.push(Part::Text {
                        t: std::mem::take(&mut text),
                    });
                }
                parts.push(Part::Hidden { h: code_point(c) });
            } else {
                text.push(c);
            }
        }
        if !text.is_empty() {
            parts.push(Part::Text { t: text });
        }
        if length > LONG_LINE_CHARS {
            long_lines += 1;
        }
        lines.push(parts);
    }

    let mut notices = Vec::new();
    if direction > 0 {
        notices.push(format!(
            "This code contains {}. They can make code look different from what will \
             actually run. Each one is shown as a marked code such as U+202E. Unless you know \
             why they are there, do not run this.",
            plural(
                direction,
                "text-direction control character",
                "text-direction control characters"
            )
        ));
    }
    if hidden > 0 {
        notices.push(format!(
            "This code contains {}. Each one is shown as a marked code such as U+200B, so \
             nothing is hidden, but ordinary code rarely has them.",
            plural(
                hidden,
                "invisible or unusual character",
                "invisible or unusual characters"
            )
        ));
    }
    if long_lines > 0 {
        notices.push(format!(
            "{} longer than {LONG_LINE_CHARS} characters. Long lines are wrapped, not cut: read \
             them to the end.",
            if long_lines == 1 {
                "1 line is".to_owned()
            } else {
                format!("{long_lines} lines are")
            }
        ));
    }
    CodeView {
        line_count: lines.len(),
        char_count: code.chars().count(),
        lines,
        notices,
    }
}

/// The title as the approval window shows it: one line, bounded, and every character that
/// cannot be seen written out as its code point.
pub fn display_title(title: &str) -> String {
    let mut shown = String::new();
    for (count, c) in title.trim().chars().enumerate() {
        if count == MAX_TITLE_CHARS {
            shown.push('…');
            break;
        }
        if c == '\n' || c == '\r' || c == '\t' {
            shown.push(' ');
        } else if is_hidden(c) {
            shown.push_str(&format!("[{}]", code_point(c)));
        } else {
            shown.push(c);
        }
    }
    if shown.is_empty() {
        "Untitled Run".to_owned()
    } else {
        shown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> Part {
        Part::Text { t: s.into() }
    }
    fn h(s: &str) -> Part {
        Part::Hidden { h: s.into() }
    }

    #[test]
    fn sha256_of_the_utf8_bytes() {
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // "é" is two bytes in UTF-8: c3 a9.
        assert_ne!(sha256_hex("é"), sha256_hex("e"));
        assert_eq!(sha256_hex("print(1)\n").len(), 64);
        assert_ne!(sha256_hex("print(1)\n"), sha256_hex("print(1)"));
    }

    #[test]
    fn size_limits() {
        assert!(check("print(1)").is_ok());
        assert_eq!(check(""), Err("There is no code to run."));
        assert_eq!(check("  \n\t"), Err("There is no code to run."));
        assert!(check(&"x".repeat(MAX_CODE_CHARS)).is_ok());
        assert!(check(&"x".repeat(MAX_CODE_CHARS + 1)).is_err());
        // Characters, not bytes: 100 000 three-byte characters are fine.
        assert!(check(&"€".repeat(MAX_CODE_CHARS)).is_ok());
        assert!(check(&"€".repeat(MAX_CODE_CHARS + 1)).is_err());
    }

    #[test]
    fn lines_are_split_the_way_python_counts_them() {
        let view = inspect("a\nb\r\nc\rd\n");
        assert_eq!(
            view.lines,
            vec![vec![t("a")], vec![t("b")], vec![t("c")], vec![t("d")]]
        );
        assert_eq!(view.line_count, 4);
        assert_eq!(view.char_count, 9);
        assert!(view.notices.is_empty());
        // Blank lines are lines; no final newline is fine.
        assert_eq!(
            inspect("a\n\n\nb").lines,
            vec![vec![t("a")], vec![], vec![], vec![t("b")]]
        );
        // A form feed or a Unicode line separator is not a line end to Python: it stays in
        // its line, and is shown.
        let view = inspect("a\u{c}b\u{2028}c\u{85}d");
        assert_eq!(view.line_count, 1);
        assert_eq!(
            view.lines[0],
            vec![
                t("a"),
                h("U+000C"),
                t("b"),
                h("U+2028"),
                t("c"),
                h("U+0085"),
                t("d")
            ]
        );
    }

    #[test]
    fn direction_controls_are_shown_and_announced() {
        // The "Trojan Source" shape: a right-to-left override inside a comment.
        let code = "access = 'user'\nif access != 'admin\u{202e} \u{2066}# check\u{2069} \u{2066}':\n    pass\n";
        let view = inspect(code);
        assert_eq!(view.notices.len(), 1);
        assert!(view.notices[0].contains("4 text-direction control characters"));
        assert!(view.lines[1].contains(&h("U+202E")));
        assert!(view.lines[1].contains(&h("U+2066")));
        assert!(view.lines[1].contains(&h("U+2069")));
        // No part of the view carries the raw character.
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains('\u{202e}') && !json.contains('\u{2066}'));
        assert!(!json.contains("\\u202e"));
    }

    #[test]
    fn invisible_characters_are_shown_and_announced() {
        for (c, name) in [
            ('\u{200b}', "U+200B"), // zero width space
            ('\u{200d}', "U+200D"), // zero width joiner
            ('\u{feff}', "U+FEFF"), // byte order mark
            ('\u{00a0}', "U+00A0"), // no-break space
            ('\u{00ad}', "U+00AD"), // soft hyphen
            ('\u{3164}', "U+3164"), // Hangul filler: an invisible letter, valid in a name
            ('\u{0}', "U+0000"),
            ('\u{1b}', "U+001B"), // escape
            ('\u{8}', "U+0008"),  // backspace
            ('\u{7f}', "U+007F"),
            ('\u{e0041}', "U+E0041"), // tag character
            ('\u{fe0f}', "U+FE0F"),   // variation selector
            ('\u{e000}', "U+E000"),   // private use
        ] {
            let view = inspect(&format!("x{c}y"));
            assert_eq!(view.lines, vec![vec![t("x"), h(name), t("y")]], "{name}");
            assert_eq!(view.notices.len(), 1, "{name}");
            assert!(
                view.notices[0].contains("1 invisible or unusual character."),
                "{name}: {}",
                view.notices[0]
            );
        }
        // Ordinary text is left alone: tabs, accents, other scripts, emoji.
        let view = inspect("\tprint('héllo, мир, 世界, 🙂')  # ok");
        assert_eq!(view.lines.len(), 1);
        assert_eq!(view.lines[0].len(), 1);
        assert!(view.notices.is_empty());
    }

    #[test]
    fn long_lines_are_announced() {
        let code = format!("x = 1{}; import os\ny = 2\n", " ".repeat(400));
        let view = inspect(&code);
        assert_eq!(view.notices.len(), 1);
        assert!(view.notices[0].starts_with("1 line is longer than 300 characters."));
        // The whole line is there, to its end.
        assert_eq!(view.lines[0], vec![t(code.lines().next().unwrap())]);
    }

    #[test]
    fn the_parts_put_together_are_the_code() {
        let code = "a\u{202e}b\n\u{200b}\n\tc d\u{a0}e\n";
        let view = inspect(code);
        let mut rebuilt = String::new();
        for line in &view.lines {
            for part in line {
                match part {
                    Part::Text { t } => rebuilt.push_str(t),
                    Part::Hidden { h } => {
                        let n = u32::from_str_radix(&h[2..], 16).unwrap();
                        rebuilt.push(char::from_u32(n).unwrap());
                    }
                }
            }
            rebuilt.push('\n');
        }
        assert_eq!(rebuilt, code);
    }

    #[test]
    fn parts_serialise_as_the_window_reads_them() {
        assert_eq!(serde_json::to_string(&t("a<b")).unwrap(), r#"{"t":"a<b"}"#);
        assert_eq!(
            serde_json::to_string(&h("U+202E")).unwrap(),
            r#"{"h":"U+202E"}"#
        );
    }

    #[test]
    fn titles_are_one_bounded_visible_line() {
        assert_eq!(display_title("  Bell state  "), "Bell state");
        assert_eq!(display_title(""), "Untitled Run");
        assert_eq!(display_title(" \n "), "Untitled Run");
        assert_eq!(display_title("a\nb\tc"), "a b c");
        assert_eq!(display_title("safe\u{202e}txt.exe"), "safe[U+202E]txt.exe");
        assert_eq!(display_title("<b>x</b>"), "<b>x</b>");
        let long = display_title(&"x".repeat(5000));
        assert_eq!(long.chars().count(), MAX_TITLE_CHARS + 1);
        assert!(long.ends_with('…'));
    }
}
