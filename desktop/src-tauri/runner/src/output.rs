//! A Run's output on its way from the pipe to the page: bytes to text, what is kept for the
//! result, and what is sent while it runs.

use std::borrow::Cow;
use std::time::{Duration, Instant};

/// The most output a result keeps (api.md §15). Counted in UTF-16 units, which is never
/// fewer than the number of characters, so the limit holds however the reader counts.
pub const MAX_OUTPUT: usize = 64_000;
const HEAD: usize = MAX_OUTPUT / 2;
const TAIL: usize = MAX_OUTPUT - HEAD;
/// Room for the marker line when the middle is dropped.
const MARKER_ROOM: usize = 100;

/// The most text one `output` event carries.
pub const MAX_EVENT: usize = 16_000;
/// `output` events are at least this far apart: about ten a second.
pub const EVENT_INTERVAL: Duration = Duration::from_millis(100);

fn units(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// Turns the bytes of a pipe into text, whatever they are: a multi-byte character split
/// between two reads is put together, and bytes that are not UTF-8 become U+FFFD.
#[derive(Default)]
pub struct Utf8Stream {
    /// The start of a character whose end has not arrived yet (at most three bytes).
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8], out: &mut String) {
        let data: Cow<[u8]> = if self.pending.is_empty() {
            Cow::Borrowed(bytes)
        } else {
            let mut joined = std::mem::take(&mut self.pending);
            joined.extend_from_slice(bytes);
            Cow::Owned(joined)
        };
        let mut rest: &[u8] = &data;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    return;
                }
                Err(error) => {
                    let (good, bad) = rest.split_at(error.valid_up_to());
                    out.push_str(std::str::from_utf8(good).expect("valid up to here"));
                    match error.error_len() {
                        Some(length) => {
                            out.push('\u{FFFD}');
                            rest = &bad[length..];
                        }
                        None => {
                            // The beginning of a character; the rest may still come.
                            self.pending = bad.to_vec();
                            return;
                        }
                    }
                }
            }
        }
    }

    /// The pipe is closed: a character that never got its end is not one.
    pub fn finish(&mut self, out: &mut String) {
        if !self.pending.is_empty() {
            self.pending.clear();
            out.push('\u{FFFD}');
        }
    }
}

/// The output kept for the result: all of it up to [`MAX_OUTPUT`]; beyond that the beginning
/// and the end, with one marker line in between saying how much was dropped.
#[derive(Default)]
pub struct Kept {
    head: String,
    head_units: usize,
    tail: String,
    tail_units: usize,
    dropped: usize,
}

impl Kept {
    pub fn push(&mut self, text: &str) {
        let mut rest = text;
        if self.head_units < HEAD {
            let mut end = 0;
            for (at, c) in text.char_indices() {
                if self.head_units + c.len_utf16() > HEAD {
                    // A character that does not fit ends the head for good.
                    self.head_units = HEAD;
                    break;
                }
                self.head_units += c.len_utf16();
                end = at + c.len_utf8();
            }
            self.head.push_str(&text[..end]);
            rest = &text[end..];
        }
        if rest.is_empty() {
            return;
        }
        self.tail.push_str(rest);
        self.tail_units += units(rest);
        if self.tail_units > 4 * TAIL {
            self.trim_tail(TAIL);
        }
    }

    /// Drops from the front of the tail until at most `limit` units are left.
    fn trim_tail(&mut self, limit: usize) {
        if self.tail_units <= limit {
            return;
        }
        let mut cut = 0;
        let mut removed = 0;
        for (at, c) in self.tail.char_indices() {
            if self.tail_units - removed <= limit {
                break;
            }
            removed += c.len_utf16();
            cut = at + c.len_utf8();
        }
        self.tail.drain(..cut);
        self.tail_units -= removed;
        self.dropped += removed;
    }

    /// The kept output, and whether its middle was dropped.
    pub fn finish(mut self) -> (String, bool) {
        if self.dropped == 0 && self.tail_units <= TAIL {
            self.head.push_str(&self.tail);
            return (self.head, false);
        }
        self.trim_tail(TAIL - MARKER_ROOM);
        let marker = format!(
            "\n[… {} characters of output are not shown …]\n",
            self.dropped
        );
        debug_assert!(units(&marker) <= MARKER_ROOM);
        self.head.push_str(&marker);
        self.head.push_str(&self.tail);
        (self.head, true)
    }
}

/// The text waiting to be sent as `output` events: at most one event per
/// [`EVENT_INTERVAL`], each at most [`MAX_EVENT`] long. When a program prints faster than
/// that, an event carries the end of what arrived and a line saying some was skipped; the
/// result's `output` is the complete record either way.
pub struct Throttle {
    unsent: String,
    skipped: bool,
    last: Option<Instant>,
}

impl Default for Throttle {
    fn default() -> Self {
        Self::new()
    }
}

impl Throttle {
    pub fn new() -> Self {
        Self {
            unsent: String::new(),
            skipped: false,
            last: None,
        }
    }

    pub fn push(&mut self, text: &str) {
        self.unsent.push_str(text);
        if self.unsent.len() > 8 * MAX_EVENT {
            self.shrink();
        }
    }

    fn shrink(&mut self) {
        let total = units(&self.unsent);
        if total <= MAX_EVENT {
            return;
        }
        let mut cut = 0;
        let mut removed = 0;
        for (at, c) in self.unsent.char_indices() {
            if total - removed <= MAX_EVENT {
                break;
            }
            removed += c.len_utf16();
            cut = at + c.len_utf8();
        }
        self.unsent.drain(..cut);
        self.skipped = true;
    }

    /// The next event's text, if there is any and the last event is long enough ago.
    pub fn due(&mut self, now: Instant) -> Option<String> {
        if self.unsent.is_empty() {
            return None;
        }
        if self
            .last
            .is_some_and(|last| now.duration_since(last) < EVENT_INTERVAL)
        {
            return None;
        }
        self.last = Some(now);
        self.take()
    }

    /// Whatever is left, at the end of the Run.
    pub fn take(&mut self) -> Option<String> {
        if self.unsent.is_empty() {
            return None;
        }
        self.shrink();
        let text = std::mem::take(&mut self.unsent);
        Some(if std::mem::take(&mut self.skipped) {
            format!("\n[… some output is not shown while the Run is in progress …]\n{text}")
        } else {
            text
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(chunks: &[&[u8]]) -> String {
        let mut stream = Utf8Stream::default();
        let mut out = String::new();
        for chunk in chunks {
            stream.push(chunk, &mut out);
        }
        stream.finish(&mut out);
        out
    }

    #[test]
    fn characters_split_between_reads_are_put_together() {
        let text = "aé€🙂z";
        let bytes = text.as_bytes();
        // Every way of cutting the bytes in two, and one byte at a time.
        for cut in 0..=bytes.len() {
            assert_eq!(
                decode(&[&bytes[..cut], &bytes[cut..]]),
                text,
                "cut at {cut}"
            );
        }
        let single: Vec<&[u8]> = bytes.chunks(1).collect();
        assert_eq!(decode(&single), text);
    }

    #[test]
    fn bytes_that_are_not_utf8_become_replacement_characters() {
        assert_eq!(decode(&[b"ok \xff\xfe end"]), "ok \u{fffd}\u{fffd} end");
        // Latin-1 "é" (0xE9) followed by ASCII: the start of a three-byte character that
        // never continues.
        assert_eq!(decode(&[b"caf\xe9 au lait"]), "caf\u{fffd} au lait");
        assert_eq!(decode(&[b"caf\xe9", b" au lait"]), "caf\u{fffd} au lait");
        // A character cut off by the end of the output.
        assert_eq!(decode(&[b"end \xe2\x82"]), "end \u{fffd}");
        assert_eq!(decode(&[b"end \xf0"]), "end \u{fffd}");
        // NUL and other control bytes are valid UTF-8 and are kept.
        assert_eq!(decode(&[b"a\0b\x1b[0m"]), "a\0b\u{1b}[0m");
        assert_eq!(decode(&[]), "");
    }

    #[test]
    fn short_output_is_kept_whole() {
        let mut kept = Kept::default();
        kept.push("hello\n");
        kept.push("world\n");
        assert_eq!(kept.finish(), ("hello\nworld\n".to_owned(), false));
        assert_eq!(Kept::default().finish(), (String::new(), false));
    }

    #[test]
    fn exactly_the_limit_is_kept_whole() {
        let text = "x".repeat(MAX_OUTPUT);
        for chunk in [1usize, 7, 1000, MAX_OUTPUT] {
            let mut kept = Kept::default();
            for piece in text.as_bytes().chunks(chunk * 13) {
                kept.push(std::str::from_utf8(piece).unwrap());
            }
            let (out, truncated) = kept.finish();
            assert!(!truncated);
            assert_eq!(out.len(), MAX_OUTPUT);
        }
    }

    #[test]
    fn long_output_keeps_its_beginning_and_end() {
        let mut kept = Kept::default();
        let mut whole = String::new();
        for n in 0..40_000 {
            let line = format!("line {n}\n");
            kept.push(&line);
            whole.push_str(&line);
        }
        let (out, truncated) = kept.finish();
        assert!(truncated);
        assert!(units(&out) <= MAX_OUTPUT, "{}", units(&out));
        assert!(units(&out) > MAX_OUTPUT - 200);
        assert!(out.starts_with("line 0\nline 1\n"));
        assert!(out.ends_with("line 39998\nline 39999\n"));
        let marker = out
            .lines()
            .find(|l| l.starts_with("[… "))
            .expect("a marker line");
        let dropped: usize = marker
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .expect("the marker names a number");
        // What is shown plus what was dropped is everything.
        let shown = units(&out) - units(marker) - 2;
        assert_eq!(shown + dropped, units(&whole));
        assert_eq!(out.matches("characters of output are not shown").count(), 1);
    }

    #[test]
    fn one_character_over_the_limit_is_truncated_within_it() {
        let mut kept = Kept::default();
        kept.push(&"y".repeat(MAX_OUTPUT + 1));
        let (out, truncated) = kept.finish();
        assert!(truncated);
        assert!(units(&out) <= MAX_OUTPUT);
    }

    #[test]
    fn the_limit_counts_utf16_units_and_never_splits_a_character() {
        // "🙂" is one character, four bytes, two UTF-16 units.
        let mut kept = Kept::default();
        for _ in 0..50_000 {
            kept.push("🙂");
        }
        let (out, truncated) = kept.finish();
        assert!(truncated);
        assert!(units(&out) <= MAX_OUTPUT);
        assert!(out.chars().count() <= MAX_OUTPUT);
        assert!(out.starts_with("🙂🙂") && out.ends_with("🙂🙂"));

        // An odd offset: the head must not end in half a pair.
        let mut kept = Kept::default();
        kept.push("a");
        kept.push(&"🙂".repeat(MAX_OUTPUT));
        let (out, _) = kept.finish();
        assert!(units(&out) <= MAX_OUTPUT);
        assert!(out.starts_with("a🙂"));
    }

    #[test]
    fn events_are_spaced_and_bounded() {
        let start = Instant::now();
        let mut throttle = Throttle::new();
        assert_eq!(throttle.due(start), None);
        throttle.push("a");
        assert_eq!(throttle.due(start).as_deref(), Some("a"));
        throttle.push("b");
        throttle.push("c");
        // Too soon after the last one.
        assert_eq!(throttle.due(start + Duration::from_millis(50)), None);
        assert_eq!(
            throttle.due(start + Duration::from_millis(100)).as_deref(),
            Some("bc")
        );
        assert_eq!(throttle.due(start + Duration::from_millis(300)), None);
        throttle.push("tail");
        assert_eq!(throttle.take().as_deref(), Some("tail"));
        assert_eq!(throttle.take(), None);

        // A flood: one event, bounded, saying that some was skipped, ending with the end.
        for n in 0..100_000 {
            throttle.push(&format!("{n}\n"));
        }
        let event = throttle.due(start + Duration::from_secs(1)).unwrap();
        assert!(units(&event) <= MAX_EVENT + 100);
        assert!(event.starts_with("\n[… some output is not shown"));
        assert!(event.ends_with("99998\n99999\n"));
        // The notice is not repeated when nothing was skipped since.
        throttle.push("calm\n");
        assert_eq!(
            throttle.due(start + Duration::from_secs(2)).as_deref(),
            Some("calm\n")
        );
    }
}
