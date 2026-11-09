//! Large Workspaces for measuring Infall at size (docs/specs/scale.md).
//!
//! `generate` writes a Local Workspace database the way a long-lived research project
//! would leave one: Frames full of Cards, Connections of every kind, Pages of text, formulas
//! and code with their Sources, To-dos, Checkpoints, and Branches forked at different
//! moments, some merged back, all as Changes by three authors over weeks of sessions. Every
//! Change goes through the core operations (`record_all`, `fork`, `checkpoint`,
//! `plan_merge`, `apply_merge`) and the store, so the result is an ordinary database: a
//! Local Workspace can be started on it, and `local::export_workspace` makes a Workspace
//! file of it.
//!
//! The content is decided by `Size::seed` alone: the same seed gives the same Cards, texts,
//! positions, authors and times. Only the ids the core makes itself (of Changes, Branches
//! and Merge batches) differ from run to run.
//!
//! `measure` starts a Local Workspace on such a database and times what the web UI asks
//! of the server, over a real socket.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use qoop_core::{
    Board, BranchId, Decision, Decisions, EntityId, EntityKind, Fields, MemberId, Op, Value,
    Workspace,
};
use serde_json::json;
use uuid::{Builder, Uuid};

use crate::auth::{hash_password, new_token};
use crate::local::{
    LOCAL_EMAIL, LocalOptions, PRESET_SETTING, Preset, export_workspace, import_workspace,
    start_local,
};
use crate::people::new_member;
use crate::store::{Role, SqliteStore, Store, TodoCard, TodoRecord};

/// How large a Workspace `generate` makes.
#[derive(Debug, Clone)]
pub struct Size {
    pub cards: usize,
    pub connections: usize,
    /// Cards with a Page.
    pub pages: usize,
    /// Of those, how many Pages are long, and how many screens each is.
    pub long_pages: usize,
    pub long_page_screens: usize,
    /// Changes on all Branches together, Merges included (at least; creating everything
    /// asked for may take a few more).
    pub changes: usize,
    /// Branches besides `main`. Every other one is merged back.
    pub branches: usize,
    pub todos: usize,
    pub seed: u64,
}

impl Size {
    /// The size M15 measures at (docs/plans/2026-11-24-road-to-1.0.md).
    pub fn full() -> Size {
        Size {
            cards: 2000,
            connections: 6000,
            pages: 200,
            long_pages: 3,
            long_page_screens: 50,
            changes: 50_000,
            branches: 12,
            todos: 60,
            seed: 1,
        }
    }

    /// A tenth of `full`, for tests.
    pub fn small() -> Size {
        Size {
            cards: 200,
            connections: 600,
            pages: 20,
            long_pages: 1,
            long_page_screens: 50,
            changes: 5000,
            branches: 4,
            todos: 10,
            seed: 1,
        }
    }
}

/// What `generate` made.
#[derive(Debug, Clone)]
pub struct Generated {
    pub member: MemberId,
    pub main: BranchId,
    /// The unmerged Branch with the most Changes: the one to preview a Merge of.
    pub open_branch: Option<BranchId>,
    pub open_branch_name: Option<String>,
    pub changes: usize,
    pub branches: usize,
    pub merged: usize,
    pub checkpoints: usize,
    /// Live entities on `main`'s head, by kind.
    pub cards: usize,
    pub frames: usize,
    pub connections: usize,
    pub blocks: usize,
    pub sources: usize,
    pub todos: usize,
    /// The id of a Card whose Page is long.
    pub long_page: Option<EntityId>,
    pub took: Duration,
}

/// Writes a new Local Workspace database at `db` (which must not exist), of `size`.
pub fn generate(size: &Size, db: &Path) -> Result<Generated, String> {
    if db.exists() {
        return Err(format!("{} already exists", db.display()));
    }
    let started = Instant::now();
    let mut g = Gen::new(size);
    g.run()?;
    let store = SqliteStore::open(db).map_err(|e| e.to_string())?;
    let password = new_token()?;
    let mut me = new_member(
        &store,
        LOCAL_EMAIL.to_string(),
        "Scale Test".to_string(),
        Role::Admin,
        None,
        hash_password(&password)?,
        START_MS,
    )
    .map_err(|e| e.to_string())?;
    me.id = g.authors[0];
    store.insert_member(&me).map_err(|e| e.to_string())?;
    store.save_workspace(&g.ws).map_err(|e| e.to_string())?;
    let todos = g.todos();
    for todo in &todos {
        store.insert_todo(todo).map_err(|e| e.to_string())?;
    }
    store
        .set_setting(PRESET_SETTING, Preset::Blank.id())
        .map_err(|e| e.to_string())?;

    let head = g.ws.head(g.main()).map_err(|e| e.to_string())?;
    let board = g.ws.board_at(head).map_err(|e| e.to_string())?;
    let count = |kind: EntityKind| {
        board
            .entities()
            .filter(|(_, e)| e.kind == kind && !e.deleted)
            .count()
    };
    let open_branch = g
        .lines
        .iter()
        .skip(1)
        .filter(|l| !l.merged)
        .max_by_key(|l| l.recorded)
        .map(|l| l.id);
    let open_branch_name = open_branch
        .and_then(|id| g.ws.branch(id))
        .map(|b| b.name().to_string());
    Ok(Generated {
        member: g.authors[0],
        main: g.main(),
        open_branch,
        open_branch_name,
        changes: g.total,
        branches: g.lines.len() - 1,
        merged: g.lines.iter().filter(|l| l.merged).count(),
        checkpoints: g.checkpoints,
        cards: count(EntityKind::Card),
        frames: count(EntityKind::Frame),
        connections: count(EntityKind::Connection),
        blocks: count(EntityKind::Block),
        sources: count(EntityKind::Source),
        todos: todos.len(),
        long_page: g.long_pages.first().copied(),
        took: started.elapsed(),
    })
}

// ---------------------------------------------------------------- randomness

/// SplitMix64: small, fast, and the same everywhere.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }

    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % (hi - lo + 1) as u64) as i64
    }

    fn chance(&mut self, p: f64) -> bool {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64 <= p
    }

    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len())]
    }

    fn uuid(&mut self) -> Uuid {
        let mut bytes = [0u8; 16];
        bytes[..8].copy_from_slice(&self.next().to_le_bytes());
        bytes[8..].copy_from_slice(&self.next().to_le_bytes());
        Builder::from_random_bytes(bytes).into_uuid()
    }

    fn entity(&mut self) -> EntityId {
        EntityId(self.uuid())
    }
}

// ---------------------------------------------------------------- words

const SUBJECTS: &[&str] = &[
    "sleep deprivation",
    "working memory load",
    "the soil microbiome",
    "graphene oxide films",
    "lattice random walks",
    "protein misfolding",
    "attention heads",
    "coral bleaching",
    "urban heat islands",
    "gut flora diversity",
    "dark matter halos",
    "early language acquisition",
    "groundwater nitrate",
    "solar wind pressure",
    "battery electrolyte decay",
    "bird migration timing",
    "ice sheet basal melt",
    "reading comprehension",
    "tumour hypoxia",
    "policy uncertainty",
    "photosynthetic efficiency",
    "neural spike timing",
    "wildfire smoke exposure",
    "polymer crystallinity",
    "bilingual switching cost",
    "the replication rate",
];

const VERBS: &[&str] = &[
    "predicts",
    "modulates",
    "reduces",
    "has no effect on",
    "scales with",
    "is confounded with",
    "doubles",
    "slows",
    "explains part of",
    "depends on",
];

const OBJECTS: &[&str] = &[
    "recall accuracy",
    "nitrogen fixation",
    "sheet resistance",
    "return probability",
    "aggregation rate",
    "in-context learning",
    "symbiont loss",
    "night-time temperature",
    "infection risk",
    "rotation curves",
    "vocabulary growth",
    "crop yield",
    "geomagnetic storms",
    "capacity fade",
    "arrival dates",
    "grounding line retreat",
    "test scores",
    "drug uptake",
    "investment",
    "growth under low light",
];

const AUTHORS: &[&str] = &[
    "Pearson",
    "Einstein",
    "Pólya",
    "Okafor",
    "Lindqvist",
    "Tanaka",
    "Moreau",
    "Haddad",
    "Kowalski",
    "Novak",
    "Ferreira",
    "Chen",
    "Abubakar",
    "Ivanova",
    "Gupta",
    "O'Neill",
];

const METHODS: &[&str] = &[
    "mixed-effects model",
    "Monte Carlo simulation",
    "difference-in-differences",
    "Bayesian hierarchical fit",
    "bootstrap confidence interval",
    "randomised controlled trial",
    "survival analysis",
    "Fourier transform",
    "principal component analysis",
    "finite-element model",
];

const FORMULAS: &[&str] = &[
    "$$\\langle R_n^2 \\rangle = n$$",
    "$$\\hat\\beta = (X^\\top X)^{-1} X^\\top y$$",
    "$$p(\\theta \\mid D) \\propto p(D \\mid \\theta)\\, p(\\theta)$$",
    "$$\\frac{\\partial u}{\\partial t} = D \\nabla^2 u$$",
    "$$H = -\\sum_i p_i \\log p_i$$",
    "$$\\mathrm{SE} = \\sigma / \\sqrt{n}$$",
    "$$\\int_0^\\infty e^{-x^2}\\, dx = \\frac{\\sqrt\\pi}{2}$$",
];

const BRANCH_NAMES: &[&str] = &[
    "reanalysis",
    "alt-hypothesis",
    "draft-for-supervisor",
    "lit-review-v2",
    "bigger-sample",
    "try-bayesian",
    "reviewer-2",
    "cleanup",
    "new-frames",
    "pilot-study",
    "rewrite-intro",
    "second-site",
    "sensitivity",
    "figures",
    "preregistration",
    "conference-cut",
];

const STATUSES: &[&str] = &["idea", "reading", "understood", "open_question", "dead_end"];
const KINDS: &[&str] = &["related", "directed", "contradicts"];
const LABELS: &[&str] = &[
    "supports",
    "comes from",
    "tests",
    "answers",
    "same data",
    "extends",
    "fails to replicate",
    "motivates",
];

/// Order keys of a Page's Blocks: two base-62 digits, never ending in the lowest one.
const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn order_key(i: usize) -> String {
    let (hi, lo) = (1 + (i / 61) % 61, 1 + i % 61);
    format!("{}{}", DIGITS[hi] as char, DIGITS[lo] as char)
}

impl Rng {
    fn title(&mut self) -> String {
        let (s, v, o) = (*self.pick(SUBJECTS), *self.pick(VERBS), *self.pick(OBJECTS));
        match self.below(7) {
            0 => format!("{} {v} {o}", capitalise(s)),
            1 => format!("Does {s} affect {o}?"),
            2 => format!(
                "{} {}: {s}",
                self.pick(AUTHORS),
                1950 + self.below(75) as i64
            ),
            3 => format!("Replication: {s} and {o}"),
            4 => format!("Pilot data on {s}"),
            5 => format!("Method: {}", self.pick(METHODS)),
            _ => format!("Why {s} {v} {o}"),
        }
    }

    fn sentence(&mut self) -> String {
        let (s, v, o) = (*self.pick(SUBJECTS), *self.pick(VERBS), *self.pick(OBJECTS));
        match self.below(8) {
            0 => format!(
                "{} {v} {o} in most of the samples we looked at.",
                capitalise(s)
            ),
            1 => format!(
                "{} et al. report that {s} {v} {o}, but their sample was small (n = {}).",
                self.pick(AUTHORS),
                12 + self.below(300)
            ),
            2 => format!(
                "A {} would separate the effect of {s} from that of {o}.",
                self.pick(METHODS)
            ),
            3 => format!("We still do not know whether {s} {v} {o} outside the lab."),
            4 => format!(
                "The effect size was {}.{} with a wide interval, so this needs more data.",
                self.below(3),
                self.below(99)
            ),
            5 => format!("If {s} {v} {o}, the next experiment should show it within a week."),
            6 => format!(
                "Compare with the {} result: the direction is the same, the size is not.",
                self.pick(AUTHORS)
            ),
            _ => format!("Note to self: check how {o} was measured before trusting this."),
        }
    }

    fn paragraph(&mut self, sentences: usize) -> String {
        (0..sentences)
            .map(|_| self.sentence())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// One Block's text: prose, a formula with its explanation, a list, or a heading.
    fn block_text(&mut self, long: bool) -> (&'static str, String) {
        let n = if long { 10 } else { 2 + self.below(4) };
        match self.below(20) {
            0..=12 => ("text", self.paragraph(n)),
            13..=15 => (
                "text",
                format!(
                    "{}\n\n{}\n\n{}",
                    self.sentence(),
                    self.pick(FORMULAS),
                    self.paragraph(n / 2 + 1)
                ),
            ),
            16..=17 => (
                "text",
                (0..n)
                    .map(|_| format!("- {}", self.sentence()))
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            18 => (
                "text",
                format!(
                    "## {}\n\n{}",
                    capitalise(self.pick(SUBJECTS)),
                    self.paragraph(n)
                ),
            ),
            _ => (
                "run",
                format!(
                    "import random\n\nN = {}\nhits = sum(random.random() < {:.2} for _ in range(N))\nprint(hits / N)\n",
                    1000 * (1 + self.below(50)),
                    self.below(100) as f64 / 100.0
                ),
            ),
        }
    }
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

// ---------------------------------------------------------------- op builders

fn text(s: impl Into<String>) -> Value {
    Value::Text(s.into())
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

fn set(entity: EntityId, field: &str, value: Value) -> Op {
    Op::Set {
        entity,
        field: field.to_string(),
        value,
    }
}

// ---------------------------------------------------------------- what a Branch holds

/// What the generator knows of a Branch's Board, enough to make only valid ops.
#[derive(Clone, Default)]
struct Model {
    deleted: HashMap<EntityId, bool>,
    cards: Vec<EntityId>,
    frames: Vec<EntityId>,
    connections: Vec<EntityId>,
    sources: Vec<EntityId>,
    pos: HashMap<EntityId, (f64, f64)>,
    texts: HashMap<(EntityId, &'static str), String>,
    /// Card → its Blocks, in creation order.
    pages: HashMap<EntityId, Vec<EntityId>>,
    page_cards: Vec<EntityId>,
}

const TEXT_FIELDS: [&str; 3] = ["title", "summary", "text"];

impl Model {
    fn of(board: &Board) -> Model {
        let mut m = Model::default();
        for (id, e) in board.entities() {
            m.create(id, e.kind, &e.fields);
            m.deleted.insert(id, e.deleted);
        }
        m
    }

    fn live(&self, id: EntityId) -> bool {
        self.deleted.get(&id) == Some(&false)
    }

    fn create(&mut self, id: EntityId, kind: EntityKind, fields: &Fields) {
        self.deleted.insert(id, false);
        match kind {
            EntityKind::Card => self.cards.push(id),
            EntityKind::Frame => self.frames.push(id),
            EntityKind::Connection => self.connections.push(id),
            EntityKind::Source => self.sources.push(id),
            EntityKind::Block => {
                if let Some(Value::Ref(card)) = fields.get("card") {
                    let list = self.pages.entry(*card).or_default();
                    if list.is_empty() {
                        self.page_cards.push(*card);
                    }
                    list.push(id);
                }
            }
            EntityKind::Attachment => {}
        }
        if let (Some(Value::Float(x)), Some(Value::Float(y))) = (fields.get("x"), fields.get("y")) {
            self.pos.insert(id, (*x, *y));
        }
        for name in TEXT_FIELDS {
            if let Some(Value::Text(t)) = fields.get(name) {
                self.texts.insert((id, name), t.clone());
            }
        }
    }

    fn apply(&mut self, op: &Op) {
        match op {
            Op::Create {
                entity,
                kind,
                fields,
            } => self.create(*entity, *kind, fields),
            Op::Set {
                entity,
                field,
                value,
            } => match (field.as_str(), value) {
                ("x", Value::Float(x)) => {
                    self.pos.entry(*entity).or_default().0 = *x;
                }
                ("y", Value::Float(y)) => {
                    self.pos.entry(*entity).or_default().1 = *y;
                }
                (name, Value::Text(t)) => {
                    if let Some(name) = TEXT_FIELDS.iter().find(|n| **n == name) {
                        self.texts.insert((*entity, name), t.clone());
                    }
                }
                _ => {}
            },
            Op::Delete { entity } => {
                self.deleted.insert(*entity, true);
            }
            Op::Undelete { entity } => {
                self.deleted.insert(*entity, false);
            }
        }
    }

    fn live_of(&self, list: &[EntityId], rng: &mut Rng) -> Option<EntityId> {
        for _ in 0..8 {
            let id = *list.get(rng.below(list.len()))?;
            if self.live(id) {
                return Some(id);
            }
        }
        list.iter().copied().find(|id| self.live(*id))
    }

    fn text_of(&self, id: EntityId, field: &'static str) -> String {
        self.texts.get(&(id, field)).cloned().unwrap_or_default()
    }
}

/// One Branch as the generator drives it.
struct Line {
    id: BranchId,
    model: Model,
    /// How many Changes it should get before it is done.
    budget: usize,
    recorded: usize,
    merge: bool,
    merged: bool,
    done: bool,
}

// ---------------------------------------------------------------- the generator

/// 2026-01-05 09:00 UTC: the project starts on a Monday morning.
const START_MS: i64 = 1_767_603_600_000;
const MINUTE: i64 = 60_000;
const FRAME_COLS: usize = 5;
const CARD_W: f64 = 224.0;
const CARD_H: f64 = 132.0;
const GAP: f64 = 40.0;
const CARDS_PER_FRAME: usize = 25;

/// What is still to be created on `main`, in an order that respects references.
enum Task {
    Frame(usize),
    Card(usize),
    Connection,
    Block(usize, usize),
    Attach(usize),
}

struct Gen<'a> {
    size: &'a Size,
    rng: Rng,
    ws: Workspace,
    authors: [MemberId; 3],
    lines: Vec<Line>,
    at: i64,
    author: usize,
    line: usize,
    session_left: usize,
    total: usize,
    checkpoints: usize,
    next_checkpoint: usize,
    tasks: std::collections::VecDeque<Task>,
    card_ids: Vec<EntityId>,
    frame_ids: Vec<EntityId>,
    frame_rects: Vec<(f64, f64, f64, f64)>,
    long_pages: Vec<EntityId>,
    forks: Vec<usize>,
}

impl<'a> Gen<'a> {
    fn new(size: &'a Size) -> Gen<'a> {
        let mut rng = Rng(size.seed);
        let authors = [
            MemberId(rng.uuid()),
            MemberId(rng.uuid()),
            MemberId(rng.uuid()),
        ];
        let (ws, main) = Workspace::new();
        let frames = size.cards.div_ceil(CARDS_PER_FRAME).max(1);
        let card_ids: Vec<EntityId> = (0..size.cards).map(|_| rng.entity()).collect();
        let frame_ids: Vec<EntityId> = (0..frames).map(|_| rng.entity()).collect();
        let fw = 5.0 * (CARD_W + GAP) + GAP;
        let fh = 5.0 * (CARD_H + GAP) + GAP + 24.0;
        let frame_rects = (0..frames)
            .map(|f| {
                let (c, r) = ((f % FRAME_COLS) as f64, (f / FRAME_COLS) as f64);
                (c * (fw + 160.0), r * (fh + 160.0), fw, fh)
            })
            .collect();

        // Which Cards get a Page, spread over the Board; the first few Pages are long.
        let mut page_blocks = HashMap::new();
        let mut long_pages = Vec::new();
        let step = (size.cards / size.pages.max(1)).max(1);
        let long_blocks = size.long_page_screens * 3;
        for p in 0..size.pages.min(size.cards) {
            let card = (p * step + step / 2).min(size.cards - 1);
            let blocks = if p < size.long_pages {
                long_pages.push(card_ids[card]);
                long_blocks
            } else {
                3 + rng.below(10)
            };
            page_blocks.insert(card, blocks);
        }

        // Frames are filled one after another: each Frame, its Cards, the Connections that
        // have become possible, then the Pages of its Cards and their Sources.
        let mut tasks = std::collections::VecDeque::new();
        let mut planned_conns = 0;
        for f in 0..frames {
            tasks.push_back(Task::Frame(f));
            let cards = (f * CARDS_PER_FRAME)..((f + 1) * CARDS_PER_FRAME).min(size.cards);
            for c in cards.clone() {
                tasks.push_back(Task::Card(c));
            }
            let want = size.connections * (f + 1) / frames;
            for _ in planned_conns..want {
                tasks.push_back(Task::Connection);
            }
            planned_conns = want;
            for c in cards {
                if let Some(&n) = page_blocks.get(&c) {
                    for b in 0..n {
                        tasks.push_back(Task::Block(c, b));
                    }
                    let sources = if long_pages.contains(&card_ids[c]) {
                        8
                    } else {
                        1 + rng.below(3)
                    };
                    for _ in 0..sources {
                        tasks.push_back(Task::Attach(c));
                    }
                }
            }
        }

        // Branch budgets: about a sixth of all Changes, unevenly; the last Branch that stays
        // open is the largest, for the Merge preview.
        let share = size.changes / 6;
        let mut lines = vec![Line {
            id: main,
            model: Model::default(),
            budget: usize::MAX,
            recorded: 0,
            merge: false,
            merged: false,
            done: false,
        }];
        let mut budgets: Vec<usize> = (0..size.branches)
            .map(|_| (share / size.branches.max(1)) * (3 + rng.below(12)) / 10)
            .collect();
        if let Some(big) = (0..size.branches).rev().find(|k| k % 2 == 1) {
            budgets[big] *= 3;
        }
        let main_budget = size.changes.saturating_sub(budgets.iter().sum::<usize>());
        let forks = (0..size.branches)
            .map(|k| main_budget * (k + 1) / (size.branches + 1))
            .collect();
        for (k, b) in budgets.into_iter().enumerate() {
            lines.push(Line {
                id: main,
                model: Model::default(),
                budget: b.max(20),
                recorded: 0,
                merge: k % 2 == 0,
                merged: false,
                done: false,
            });
        }
        Gen {
            size,
            rng,
            ws,
            authors,
            lines,
            at: START_MS,
            author: 0,
            line: 0,
            session_left: 0,
            total: 0,
            checkpoints: 0,
            next_checkpoint: size.changes / 12,
            tasks,
            card_ids,
            frame_ids,
            frame_rects,
            long_pages,
            forks,
        }
    }

    fn main(&self) -> BranchId {
        self.lines[0].id
    }

    /// Changes still owed by the creation tasks, roughly.
    fn creation_left(&self) -> usize {
        self.tasks.len() * 3 / 2
    }

    fn run(&mut self) -> Result<(), String> {
        while self.total < self.size.changes || !self.tasks.is_empty() {
            if self.session_left == 0 {
                self.start_session();
            }
            self.session_left -= 1;
            let line = self.line;
            let batches = if line == 0 && self.should_create() {
                vec![self.creation()]
            } else {
                self.edit(line)
            };
            for (i, ops) in batches.into_iter().enumerate() {
                if ops.is_empty() {
                    continue;
                }
                self.at += if i == 0 {
                    self.rng.range(4_000, 150_000)
                } else {
                    self.rng.range(1_500, 4_000)
                };
                self.record(line, ops)?;
            }
            self.after_record(line)?;
        }
        Ok(())
    }

    fn should_create(&mut self) -> bool {
        let left = self.creation_left();
        if left == 0 {
            return false;
        }
        let room = self.size.changes.saturating_sub(self.total);
        if room <= left + 200 {
            return true;
        }
        self.rng.chance(left as f64 / room as f64 * 1.3)
    }

    /// A new session: someone sits down, later, on one Branch.
    fn start_session(&mut self) {
        self.at += match self.rng.below(10) {
            0..=5 => self.rng.range(30 * MINUTE, 4 * 60 * MINUTE),
            6..=8 => self.rng.range(14 * 60 * MINUTE, 20 * 60 * MINUTE),
            _ => self.rng.range(40 * 60 * MINUTE, 70 * 60 * MINUTE),
        };
        self.author = match self.rng.below(20) {
            0..=11 => 0,
            12..=16 => 1,
            _ => 2,
        };
        let open: Vec<usize> = (1..self.lines.len())
            .filter(|&k| self.lines[k].model.cards.len() + self.lines[k].model.frames.len() > 0)
            .filter(|&k| !self.lines[k].done)
            .collect();
        self.line = if !open.is_empty() && self.rng.chance(0.3) {
            *self.rng.pick(&open)
        } else {
            0
        };
        self.session_left = 8 + self.rng.below(120);
    }

    fn record(&mut self, line: usize, ops: Vec<Op>) -> Result<(), String> {
        let n = ops.len();
        for op in &ops {
            self.lines[line].model.apply(op);
        }
        let branch = self.lines[line].id;
        self.ws
            .record_all(branch, self.authors[self.author], self.at, ops)
            .map_err(|e| format!("a generated edit was refused: {e}"))?;
        self.total += n;
        self.lines[line].recorded += n;
        Ok(())
    }

    /// Checkpoints, forks and Merges, once enough has happened.
    fn after_record(&mut self, line: usize) -> Result<(), String> {
        let author = self.authors[self.author];
        if line == 0 && self.total >= self.next_checkpoint {
            self.next_checkpoint += self.size.changes / 12;
            let head = self.ws.head(self.main()).map_err(|e| e.to_string())?;
            let name = format!(
                "Week {} review",
                (self.at - START_MS) / (7 * 24 * 60 * MINUTE) + 1
            );
            if self.ws.checkpoint(&name, head, author, self.at).is_ok() {
                self.checkpoints += 1;
            }
        }
        // The next Branch is forked once `main` has come far enough.
        if line == 0 {
            let k = self
                .lines
                .iter()
                .skip(1)
                .filter(|l| l.id != self.main())
                .count();
            if k < self.forks.len() && self.lines[0].recorded >= self.forks[k] {
                let head = self.ws.head(self.main()).map_err(|e| e.to_string())?;
                let name = BRANCH_NAMES[k % BRANCH_NAMES.len()].to_string();
                let name = if k >= BRANCH_NAMES.len() {
                    format!("{name}-{k}")
                } else {
                    name
                };
                self.at += self.rng.range(5_000, 60_000);
                let id = self
                    .ws
                    .fork(&name, head, author, self.at)
                    .map_err(|e| e.to_string())?;
                let model = self.lines[0].model.clone();
                let l = &mut self.lines[k + 1];
                l.id = id;
                l.model = model;
            }
        }
        if line > 0
            && !self.lines[line].done
            && self.lines[line].recorded >= self.lines[line].budget
        {
            self.lines[line].done = true;
            self.session_left = 0;
            if self.lines[line].merge {
                self.merge(line)?;
            }
        } else if line > 0
            && self.lines[line].recorded * 2 >= self.lines[line].budget
            && self.rng.chance(0.02)
        {
            let head = self
                .ws
                .head(self.lines[line].id)
                .map_err(|e| e.to_string())?;
            if self.ws.checkpoint("Halfway", head, author, self.at).is_ok() {
                self.checkpoints += 1;
            }
        }
        Ok(())
    }

    /// Merges the Branch of `line` into `main`, taking the Branch's side of every Conflict.
    fn merge(&mut self, line: usize) -> Result<(), String> {
        let (source, target) = (self.lines[line].id, self.main());
        let plan = self
            .ws
            .plan_merge(source, target)
            .map_err(|e| e.to_string())?;
        let mut decisions = Decisions::new();
        for c in &plan.conflicts {
            decisions.insert(c.key(), Decision::TakeSource);
        }
        self.at += self.rng.range(60_000, 600_000);
        let checkpoint = self.rng.chance(0.5).then(|| {
            let name = self.ws.branch(source).map(|b| b.name().to_string());
            format!("Before merging {}", name.unwrap_or_default())
        });
        let before = self.ws.head(target).map_err(|e| e.to_string())?.seq;
        let head = self
            .ws
            .apply_merge(
                &plan,
                &decisions,
                self.authors[self.author],
                self.at,
                checkpoint.as_deref(),
            )
            .map_err(|e| e.to_string())?;
        if checkpoint.is_some() {
            self.checkpoints += 1;
        }
        let n = (head.seq - before) as usize;
        self.total += n;
        self.lines[0].recorded += n;
        self.lines[line].merged = true;
        self.lines[0].model = Model::of(&self.ws.board_at(head).map_err(|e| e.to_string())?);
        Ok(())
    }

    // ---- creating what the Board is made of

    fn card_spot(&mut self, c: usize) -> (f64, f64) {
        let f = c / CARDS_PER_FRAME;
        let slot = c % CARDS_PER_FRAME;
        let (fx, fy, _, _) = self.frame_rects[f];
        let jitter = |r: &mut Rng| r.range(-8, 8) as f64;
        (
            fx + GAP + (slot % 5) as f64 * (CARD_W + GAP) + jitter(&mut self.rng),
            fy + GAP + 24.0 + (slot / 5) as f64 * (CARD_H + GAP) + jitter(&mut self.rng),
        )
    }

    fn creation(&mut self) -> Vec<Op> {
        let Some(task) = self.tasks.pop_front() else {
            return Vec::new();
        };
        let rng = &mut self.rng;
        match task {
            Task::Frame(f) => {
                let (x, y, w, h) = self.frame_rects[f];
                let title = capitalise(rng.pick(SUBJECTS));
                vec![create(
                    self.frame_ids[f],
                    EntityKind::Frame,
                    vec![
                        ("title", text(title)),
                        ("x", Value::Float(x)),
                        ("y", Value::Float(y)),
                        ("w", Value::Float(w)),
                        ("h", Value::Float(h)),
                    ],
                )]
            }
            Task::Card(c) => {
                let (x, y) = self.card_spot(c);
                let long = self
                    .long_pages
                    .iter()
                    .position(|id| *id == self.card_ids[c]);
                let rng = &mut self.rng;
                // The long Pages are lab notebooks, easy to find by name.
                let title = match long {
                    Some(k) => format!("Lab notebook {}", k + 1),
                    None => rng.title(),
                };
                let sentences = 1 + rng.below(2);
                let summary = rng.paragraph(sentences);
                let status = *rng.pick(STATUSES);
                vec![create(
                    self.card_ids[c],
                    EntityKind::Card,
                    vec![
                        ("title", text(title)),
                        ("status", text(status)),
                        ("summary", text(summary)),
                        ("x", Value::Float(x)),
                        ("y", Value::Float(y)),
                    ],
                )]
            }
            Task::Connection => self.new_connection(0).into_iter().collect(),
            Task::Block(c, b) => {
                let long = self.long_pages.contains(&self.card_ids[c]);
                let (kind, body) = self.rng.block_text(long);
                let mut fields = vec![
                    ("card", Value::Ref(self.card_ids[c])),
                    ("type", text(kind)),
                    ("order", text(order_key(b))),
                    ("text", text(body)),
                ];
                if kind == "run" {
                    fields.push(("title", text("Quick simulation")));
                }
                vec![create(self.rng.entity(), EntityKind::Block, fields)]
            }
            Task::Attach(c) => {
                let card = self.card_ids[c];
                let existing = self.lines[0].model.sources.clone();
                let rng = &mut self.rng;
                let mut ops = Vec::new();
                let source = if existing.is_empty() || rng.chance(0.75) {
                    let id = rng.entity();
                    let author = *rng.pick(AUTHORS);
                    let year = 1950 + rng.below(75);
                    let title = capitalise(&rng.title());
                    ops.push(create(
                        id,
                        EntityKind::Source,
                        vec![
                            ("title", text(title)),
                            ("authors", text(format!("{author}, {}.", rng.pick(AUTHORS)))),
                            ("year", text(year.to_string())),
                            (
                                "doi",
                                text(format!(
                                    "10.{}/{}",
                                    1000 + rng.below(9000),
                                    rng.next() % 1_000_000
                                )),
                            ),
                        ],
                    ));
                    id
                } else {
                    *rng.pick(&existing)
                };
                ops.push(create(
                    rng.entity(),
                    EntityKind::Attachment,
                    vec![("card", Value::Ref(card)), ("source", Value::Ref(source))],
                ));
                ops
            }
        }
    }

    /// A Connection between two Cards of `line`, mostly near each other.
    fn new_connection(&mut self, line: usize) -> Option<Op> {
        let m = &self.lines[line].model;
        let n = m.cards.len();
        if n < 2 {
            return None;
        }
        let rng = &mut self.rng;
        let a = if rng.chance(0.7) {
            n - 1 - rng.below(n.min(60))
        } else {
            rng.below(n)
        };
        let b = if rng.chance(0.75) {
            let d = 1 + rng.below(30);
            if rng.chance(0.5) {
                a.saturating_sub(d)
            } else {
                (a + d).min(n - 1)
            }
        } else {
            rng.below(n)
        };
        let (a, b) = (m.cards[a], m.cards[b]);
        if a == b {
            return None;
        }
        let kind = match rng.below(10) {
            0..=4 => KINDS[0],
            5..=8 => KINDS[1],
            _ => KINDS[2],
        };
        let mut fields = vec![
            ("from", Value::Ref(a)),
            ("to", Value::Ref(b)),
            ("kind", text(kind)),
        ];
        if rng.chance(0.25) {
            fields.push(("label", text(*rng.pick(LABELS))));
        }
        Some(create(rng.entity(), EntityKind::Connection, fields))
    }

    // ---- everyday edits

    /// One edit on `line`, as the batches a person's actions send: a move, typing (several
    /// saves of the same text a few seconds apart), a status, a Connection, a deletion.
    fn edit(&mut self, line: usize) -> Vec<Vec<Op>> {
        let roll = self.rng.below(100);
        if (78..=83).contains(&roll) {
            return vec![self.new_connection(line).into_iter().collect()];
        }
        let m = &self.lines[line].model;
        let rng = &mut self.rng;
        let card = m.live_of(&m.cards, rng);
        match (roll, card) {
            (0..=27, Some(card)) => {
                let (x, y) = m.pos.get(&card).copied().unwrap_or_default();
                let (dx, dy) = (rng.range(-300, 300) as f64, rng.range(-200, 200) as f64);
                vec![vec![
                    set(card, "x", Value::Float((x + dx).round())),
                    set(card, "y", Value::Float((y + dy).round())),
                ]]
            }
            (28..=29, _) => {
                let Some(frame) = m.live_of(&m.frames, rng) else {
                    return Vec::new();
                };
                let (x, y) = m.pos.get(&frame).copied().unwrap_or_default();
                vec![vec![
                    set(frame, "x", Value::Float(x + rng.range(-80, 80) as f64)),
                    set(frame, "y", Value::Float(y + rng.range(-80, 80) as f64)),
                ]]
            }
            (30..=42, Some(card)) => {
                let base = m.text_of(card, "summary");
                typing(rng, card, "summary", base, 600)
            }
            (43..=62, _) => {
                let Some(page) = m.live_of(&m.page_cards, rng) else {
                    return Vec::new();
                };
                let blocks = &m.pages[&page];
                let block = blocks[rng.below(blocks.len())];
                if !m.live(block) {
                    return Vec::new();
                }
                let base = m.text_of(block, "text");
                typing(rng, block, "text", base, 4000)
            }
            // A lab notebook keeps its name.
            (63..=69, Some(card)) if !m.text_of(card, "title").starts_with("Lab notebook") => {
                vec![vec![set(card, "title", text(rng.title()))]]
            }
            (70..=77, Some(card)) => vec![vec![set(card, "status", text(*rng.pick(STATUSES)))]],
            (84..=86, _) => {
                let Some(conn) = m.live_of(&m.connections, rng) else {
                    return Vec::new();
                };
                if rng.chance(0.5) {
                    vec![vec![Op::Delete { entity: conn }]]
                } else {
                    vec![vec![set(conn, "label", text(*rng.pick(LABELS)))]]
                }
            }
            (87..=88, Some(card)) => vec![vec![Op::Delete { entity: card }]],
            (89..=90, _) => {
                // Something deleted earlier comes back.
                let gone = m.cards.iter().find(|id| m.deleted.get(id) == Some(&true));
                match gone {
                    Some(id) => vec![vec![Op::Undelete { entity: *id }]],
                    None => Vec::new(),
                }
            }
            (91..=94, _) => {
                let Some(page) = m.live_of(&m.page_cards, rng) else {
                    return Vec::new();
                };
                let n = m.pages[&page].len();
                let (kind, body) = rng.block_text(false);
                vec![vec![create(
                    rng.entity(),
                    EntityKind::Block,
                    vec![
                        ("card", Value::Ref(page)),
                        ("type", text(kind)),
                        ("order", text(order_key(n + 1))),
                        ("text", text(body)),
                    ],
                )]]
            }
            (95..=99, _) if line > 0 => {
                // A Branch gets Cards of its own.
                let id = rng.entity();
                let (x, y) = (rng.range(0, 6000) as f64, rng.range(-1200, -200) as f64);
                vec![vec![create(
                    id,
                    EntityKind::Card,
                    vec![
                        ("title", text(rng.title())),
                        ("status", text("idea")),
                        ("summary", text(rng.sentence())),
                        ("x", Value::Float(x)),
                        ("y", Value::Float(y)),
                    ],
                )]]
            }
            (_, Some(card)) => {
                let base = m.text_of(card, "summary");
                typing(rng, card, "summary", base, 600)
            }
            _ => Vec::new(),
        }
    }

    // ---- To-dos

    fn todos(&mut self) -> Vec<TodoRecord> {
        let main = self.main();
        let m = &self.lines[0].model;
        (0..self.size.todos)
            .map(|i| {
                let rng = &mut self.rng;
                let card = if rng.chance(0.6) {
                    m.live_of(&m.cards, rng)
                } else {
                    None
                };
                let created_at = START_MS + rng.range(0, 60 * 24 * 60 * MINUTE);
                let done = rng.chance(0.3);
                TodoRecord {
                    id: rng.uuid(),
                    owner: self.authors[0],
                    text: match i % 4 {
                        0 => format!("Read {} on {}", rng.pick(AUTHORS), rng.pick(SUBJECTS)),
                        1 => format!("Rerun the {} with the new data", rng.pick(METHODS)),
                        2 => format!("Ask about {}", rng.pick(OBJECTS)),
                        _ => "Tidy the Frames before the meeting".to_string(),
                    },
                    done,
                    done_at: done.then_some(created_at + 3 * 24 * 60 * MINUTE),
                    created_by: self.authors[0],
                    created_at,
                    card: card.map(|id| TodoCard {
                        id: id.0,
                        title: m.text_of(id, "title"),
                        branch: main.0,
                    }),
                }
            })
            .collect()
    }
}

/// Typing in a text: a few saves a few seconds apart, each a little longer, or, once the
/// text is long, a sentence rewritten.
fn typing(
    rng: &mut Rng,
    entity: EntityId,
    field: &str,
    mut text_now: String,
    cap: usize,
) -> Vec<Vec<Op>> {
    let saves = 1 + rng.below(6);
    let mut out = Vec::with_capacity(saves);
    if text_now.chars().count() > cap {
        let cut = text_now
            .char_indices()
            .nth(cap / 2)
            .map_or(text_now.len(), |(i, _)| i);
        text_now.truncate(cut);
    }
    let words = rng.sentence();
    let words: Vec<&str> = words.split(' ').collect();
    let per = words.len().div_ceil(saves).max(1);
    let mut sep = if text_now.is_empty() { "" } else { " " };
    for chunk in words.chunks(per) {
        text_now.push_str(sep);
        text_now.push_str(&chunk.join(" "));
        sep = " ";
        out.push(vec![set(entity, field, text(text_now.clone()))]);
    }
    out
}

// ---------------------------------------------------------------- measuring

/// One timed request.
#[derive(Debug, Clone, Copy, Default)]
pub struct Timed {
    pub ms: f64,
    pub bytes: usize,
}

/// What `measure` found.
#[derive(Debug, Clone, Default)]
pub struct Measured {
    /// `start_local` on the database: open, read and check the Workspace, listen.
    pub start: Timed,
    /// `GET /api/branches/{main}/board`, the first time.
    pub board: Timed,
    /// The same, once more (warm).
    pub board_again: Timed,
    /// What History asks for when it opens: every Change of `main`, its Checkpoints, and
    /// its Board at 0.
    pub history: Timed,
    /// `GET /api/merges/plan` for the largest unmerged Branch into `main`.
    pub merge_plan: Option<Timed>,
    /// `POST …/ops` moving one Card, median of several.
    pub edit: Timed,
    /// The 95th percentile of the same edits (the slowest but one in twenty).
    pub edit_p95_ms: f64,
    pub edit_max_ms: f64,
    /// `export_workspace` (also what a backup does) and the file it wrote.
    pub export: Timed,
    /// `import_workspace` of that file.
    pub import: Timed,
}

/// Starts a Local Workspace on a copy of `db` and times what the web UI asks of it.
/// Scratch files go in `scratch`, which must exist.
pub async fn measure(
    db: &Path,
    web_dir: &Path,
    scratch: &Path,
    open_branch: Option<BranchId>,
    edits: usize,
) -> Result<Measured, String> {
    let mut out = Measured::default();
    let copy = scratch.join("measured.db");
    let _ = std::fs::remove_file(&copy);
    std::fs::copy(db, &copy).map_err(|e| e.to_string())?;

    let t = Instant::now();
    let server = start_local(LocalOptions {
        db: copy.clone(),
        web_dir: web_dir.to_path_buf(),
        preset: Preset::Blank,
        member_name: "Scale Test".to_string(),
        port: None,
    })
    .await
    .map_err(|e| e.to_string())?;
    out.start.ms = ms(t);

    let origin = server.origin().to_string();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let entered = client
        .get(server.entry_url())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let cookie = entered
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .ok_or("the entry gave no cookie")?
        .to_string();
    let get = |path: String| {
        let (client, cookie, origin) = (client.clone(), cookie.clone(), origin.clone());
        async move {
            let t = Instant::now();
            let res = client
                .get(format!("{origin}{path}"))
                .header(reqwest::header::COOKIE, cookie)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = res.status();
            let body = res.bytes().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!("GET {path}: {status}"));
            }
            Ok::<_, String>((
                Timed {
                    ms: ms(t),
                    bytes: body.len(),
                },
                body,
            ))
        }
    };

    let (_, branches) = get("/api/branches".to_string()).await?;
    let branches: serde_json::Value =
        serde_json::from_slice(&branches).map_err(|e| e.to_string())?;
    let main = branches["branches"]
        .as_array()
        .and_then(|list| list.iter().find(|b| b["name"] == "main"))
        .and_then(|b| b["id"].as_str())
        .ok_or("no main Branch")?
        .to_string();
    let (board, body) = get(format!("/api/branches/{main}/board")).await?;
    out.board = board;
    out.board_again = get(format!("/api/branches/{main}/board")).await?.0;

    let t = Instant::now();
    let (a, b, c) = tokio::join!(
        get(format!("/api/branches/{main}/changes?after=0")),
        get(format!("/api/branches/{main}/checkpoints")),
        get(format!("/api/branches/{main}/board?at=0")),
    );
    out.history = Timed {
        ms: ms(t),
        bytes: a?.0.bytes + b?.0.bytes + c?.0.bytes,
    };

    if let Some(open) = open_branch {
        out.merge_plan = Some(
            get(format!("/api/merges/plan?source={}&target={main}", open.0))
                .await?
                .0,
        );
    }

    // A Card moved, again and again, as a drag's drop sends it.
    let board: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let card = board["entities"]
        .as_object()
        .and_then(|all| {
            all.iter()
                .find(|(_, e)| e["kind"] == "Card" && e["deleted"] == false)
        })
        .map(|(id, _)| id.clone())
        .ok_or("no Card to move")?;
    let mut times = Vec::new();
    for i in 0..edits {
        let ops = json!({ "ops": [
            { "Set": { "entity": card, "field": "x", "value": { "Float": 100.0 + i as f64 } } },
            { "Set": { "entity": card, "field": "y", "value": { "Float": 50.0 } } },
        ]});
        let t = Instant::now();
        let res = client
            .post(format!("{origin}/api/branches/{main}/ops"))
            .header(reqwest::header::COOKIE, &cookie)
            .header(reqwest::header::ORIGIN, &origin)
            .header("x-qoop-request", "1")
            .json(&ops)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        let body = res.bytes().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "POST ops: {status} {}",
                String::from_utf8_lossy(&body)
            ));
        }
        times.push(ms(t));
    }
    times.sort_by(f64::total_cmp);
    out.edit.ms = times.get(times.len() / 2).copied().unwrap_or_default();
    let p95 = (times.len() * 95).div_ceil(100).saturating_sub(1);
    out.edit_p95_ms = times.get(p95).copied().unwrap_or_default();
    out.edit_max_ms = times.last().copied().unwrap_or_default();
    server.stop().await;

    let file = scratch.join("measured.infall");
    let _ = std::fs::remove_file(&file);
    let t = Instant::now();
    tokio::task::spawn_blocking({
        let (copy, file) = (copy.clone(), file.clone());
        move || export_workspace(&copy, &file)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    out.export = Timed {
        ms: ms(t),
        bytes: std::fs::metadata(&file).map_or(0, |m| m.len() as usize),
    };

    let imported: PathBuf = scratch.join("imported.db");
    let _ = std::fs::remove_file(&imported);
    let t = Instant::now();
    tokio::task::spawn_blocking({
        let (file, imported) = (file.clone(), imported.clone());
        move || import_workspace(&file, &imported)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    out.import = Timed {
        ms: ms(t),
        bytes: std::fs::metadata(&imported).map_or(0, |m| m.len() as usize),
    };
    for leftover in [&copy, &file, &imported] {
        let _ = std::fs::remove_file(leftover);
        let mut key = leftover.as_os_str().to_os_string();
        key.push(".secret-key");
        let _ = std::fs::remove_file(PathBuf::from(key));
    }
    Ok(out)
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_keys_sort_in_creation_order_and_never_end_low() {
        let keys: Vec<String> = (0..400).map(order_key).collect();
        assert!(keys.windows(2).all(|w| w[0] < w[1]));
        assert!(keys.iter().all(|k| !k.ends_with('0')));
    }

    #[test]
    fn the_same_seed_gives_the_same_content() {
        let size = Size {
            changes: 600,
            cards: 40,
            connections: 80,
            pages: 4,
            long_pages: 1,
            long_page_screens: 2,
            branches: 2,
            todos: 2,
            seed: 7,
        };
        let board = |size: &Size| {
            let mut g = Gen::new(size);
            g.run().unwrap();
            let head = g.ws.head(g.main()).unwrap();
            let board = g.ws.board_at(head).unwrap();
            (g.total, board)
        };
        let (n, a) = board(&size);
        let (m, b) = board(&size);
        assert!(n >= 600);
        assert_eq!(n, m);
        assert_eq!(a, b);
    }
}
