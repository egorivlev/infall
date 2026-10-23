//! Reading a Branch's Changes as Activities (CONTEXT.md "Activity"; docs/specs/branch-graph.md §1).
//!
//! An Activity is a way of reading history, not something recorded. The same rule lives in
//! `web/src/lib/activities.ts` for History; both are checked against one shared fixture,
//! `docs/specs/branch-graph-activities.json`.

use serde::{Deserialize, Serialize};

use crate::ids::{BatchId, MemberId};
use crate::workspace::{Change, Moment, Origin};

/// The longest pause, in milliseconds, between two neighbouring Changes of one edit Activity
/// that History and the Branch Graph use.
pub const ACTIVITY_GAP_MS: i64 = 10 * 60 * 1000;

/// What an Activity is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityKind {
    Edit,
    Merge,
    Restore,
}

/// One Activity of a Branch: the Changes `(from_seq, to_seq]`, without their contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activity {
    pub kind: ActivityKind,
    pub author: MemberId,
    pub from_seq: u64,
    pub to_seq: u64,
    /// `at` of its first Change.
    pub started_at: i64,
    /// `at` of its last Change.
    pub ended_at: i64,
    /// A Merge: the source moment it brought in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Moment>,
    /// A Restore: the moment of this Branch it returned to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<u64>,
}

/// Which run a Change belongs to: edits by one author, or one Restore or Merge batch.
#[derive(PartialEq)]
enum Run {
    Edit(MemberId),
    Batch(BatchId),
}

fn run_of(c: &Change) -> Run {
    match &c.origin {
        Origin::Edit => Run::Edit(c.author),
        Origin::Restore { batch, .. } | Origin::Merge { batch, .. } => Run::Batch(*batch),
    }
}

/// Reads `changes` (a Branch's log from its first Change, in order) as Activities, oldest
/// first. They do not overlap and together cover `(0, changes.len()]`.
///
/// - Consecutive `Edit` Changes by one author with no pause over `gap_ms` between neighbours
///   are one Activity. A clock that went backwards is no pause.
/// - The Changes of one Restore or Merge batch are one Activity of that kind.
/// - A Checkpoint always ends the Activity it falls in: no Activity reaches across a moment in
///   `checkpoints` (seqs, in any order; duplicates and moments outside the log are ignored).
///
/// One pass over the log; nothing is applied.
pub fn activities(changes: &[Change], checkpoints: &[u64], gap_ms: i64) -> Vec<Activity> {
    let mut cuts: Vec<u64> = checkpoints.to_vec();
    cuts.sort_unstable();
    cuts.dedup();
    let mut cut = cuts.iter().copied().peekable();

    let mut out = Vec::new();
    let mut i = 0;
    while i < changes.len() {
        let first = &changes[i];
        let run = run_of(first);
        // The first Checkpoint after the start of this Activity ends it.
        while cut.next_if(|&s| s <= i as u64).is_some() {}
        let stop = cut.peek().copied();
        let mut j = i + 1;
        while j < changes.len() {
            if stop == Some(j as u64) {
                break;
            }
            let c = &changes[j];
            if run_of(c) != run {
                break;
            }
            if matches!(run, Run::Edit(_)) && c.at.saturating_sub(changes[j - 1].at) > gap_ms {
                break;
            }
            j += 1;
        }
        let (kind, source, to) = match &first.origin {
            Origin::Edit => (ActivityKind::Edit, None, None),
            Origin::Merge { source, .. } => (ActivityKind::Merge, Some(*source), None),
            Origin::Restore { to_seq, .. } => (ActivityKind::Restore, None, Some(*to_seq)),
        };
        out.push(Activity {
            kind,
            author: first.author,
            from_seq: i as u64,
            to_seq: j as u64,
            started_at: first.at,
            ended_at: changes[j - 1].at,
            source,
            to,
        });
        i = j;
    }
    out
}
