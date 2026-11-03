use fusor::{JsInputs, Signal, signal};
use serde::Deserialize;

use crate::latency::{Cell, Header, Turn, headers, medians};

/// A runtime build and its bundle, once loaded.
#[derive(Clone, PartialEq, Deserialize)]
struct Loaded {
    build: String,
    threads: u32,
    bundle_bytes: f64,
    load_ms: f64,
    // Every part came from this device's storage.
    from_device: bool,
}

/// One of the call's three engines, as `web/app.js` reports it while it loads.
#[derive(Clone, PartialEq, Deserialize)]
struct Engine {
    id: String,
    label: String,
    fraction: f64,
    detail: String,
    loaded: Option<Loaded>,
}

impl Engine {
    fn status(&self) -> String {
        let Some(loaded) = &self.loaded else {
            return self.detail.clone();
        };
        let threads = match loaded.threads {
            1 => "1 thread".to_string(),
            count => format!("{count} threads"),
        };
        format!(
            "{} · {threads} · {:.0} MB · ready in {:.1} s",
            loaded.build,
            loaded.bundle_bytes / 1e6,
            loaded.load_ms / 1000.0
        )
    }
}

/// A voice of the TTS bundle.
#[derive(Clone, PartialEq, Deserialize)]
struct Voice {
    id: String,
    label: String,
}

// What `web/app.js` reports, one JSON object per `engine` event.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Report {
    Engine { engine: Engine },
    Voices { voices: Vec<Voice> },
    Calling { active: bool },
    Status { status: String },
    // The microphone's level, 1 being the level of speech.
    Level { level: f64 },
    // The caller's words so far, while they have the floor.
    Hearing { text: String },
    Turn { turn: Turn },
    // Network requests the engines made since their models loaded.
    Network { requests: u32 },
    // A model could not load, or an engine died: nothing more can run in this page.
    Broken { message: String },
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Loading,
    Idle,
    Calling,
    Broken,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Idle => "idle",
            Self::Calling => "calling",
            Self::Broken => "broken",
        }
    }
}

#[derive(JsInputs)]
struct App {
    // `web/app.js` starts or ends the call on every new count, inside the user's gesture.
    #[js]
    calls: Signal<u32>,
    engines: Signal<Vec<Engine>>,
    voices: Signal<Vec<Voice>>,
    voice: Signal<String>,
    calling: Signal<bool>,
    status: Signal<String>,
    level: Signal<f64>,
    hearing: Signal<String>,
    turns: Signal<Vec<Turn>>,
    requests: Signal<u32>,
    failure: Signal<Option<String>>,
}

impl App {
    fn new() -> Self {
        Self {
            calls: signal(0),
            engines: signal(Vec::new()),
            voices: signal(Vec::new()),
            voice: signal(String::new()),
            calling: signal(false),
            status: signal("Loading the models…".into()),
            level: signal(0.0),
            hearing: signal(String::new()),
            turns: signal(Vec::new()),
            requests: signal(0),
            failure: signal(None),
        }
    }

    fn call(&self) {
        self.calls.update(|count| *count += 1);
    }

    fn receive(&self, event: web_sys::Event) {
        let json = fusor::js::event_detail::<String>(&event).expect("web/app.js sends strings");
        let report = serde_json::from_str(&json).expect("web/app.js sends engine reports");
        match report {
            Report::Engine { engine } => self
                .engines
                .update(|engines| upsert(engines, engine, |each| each.id.clone())),
            Report::Voices { voices } => self.offer(voices),
            Report::Calling { active } => self.calling.set(active),
            Report::Status { status } => self.status.set(status),
            Report::Level { level } => self.level.set(level),
            Report::Hearing { text } => self.hearing.set(text),
            Report::Turn { turn } => self
                .turns
                .update(|turns| upsert(turns, turn, |each| each.id)),
            Report::Network { requests } => self.requests.set(requests),
            Report::Broken { message } => self.failure.set(Some(message)),
        }
    }

    fn offer(&self, voices: Vec<Voice>) {
        if let Some(first) = voices.first() {
            self.voice.set(first.id.clone());
        }
        self.voices.set(voices);
    }

    fn phase(&self) -> Phase {
        if self.failure.get().is_some() {
            Phase::Broken
        } else if self.calling.get() {
            Phase::Calling
        } else if self.loaded() {
            Phase::Idle
        } else {
            Phase::Loading
        }
    }

    fn loaded(&self) -> bool {
        let engines = self.engines.get();
        !engines.is_empty() && engines.iter().all(|engine| engine.loaded.is_some())
    }

    fn call_label(&self) -> &'static str {
        if self.calling.get() {
            "Hang up"
        } else {
            "Start call"
        }
    }

    /// The level bar's fill, half the bar being the level of speech.
    fn level_style(&self) -> String {
        format!("--level: {:.3}", (self.level.get() / 2.0).min(1.0))
    }

    fn headers(&self) -> Vec<Header> {
        headers()
    }

    fn medians(&self) -> Vec<Cell> {
        medians(&self.turns.get())
    }

    fn network(&self) -> String {
        match self.requests.get() {
            1 => "1 network request since the models loaded".into(),
            count => format!("{count} network requests since the models loaded"),
        }
    }

    /// The three bundles' load once all are in; `e2e/run.mjs` reads where they came from.
    fn summary(&self) -> String {
        if !self.loaded() {
            return String::new();
        }
        let engines = self.engines.get();
        let loaded: Vec<&Loaded> = engines
            .iter()
            .filter_map(|engine| engine.loaded.as_ref())
            .collect();
        let bytes: f64 = loaded.iter().map(|each| each.bundle_bytes).sum();
        let slowest = loaded.iter().map(|each| each.load_ms).fold(0.0, f64::max);
        let source = if loaded.iter().all(|each| each.from_device) {
            "every model loaded from this device"
        } else {
            "models downloaded"
        };
        format!(
            "{:.0} MB of bundles · {source} in {:.1} s",
            bytes / 1e6,
            slowest / 1000.0
        )
    }
}

/// Replaces the item of `items` with `item`'s key, or appends `item`.
fn upsert<T, K: PartialEq>(items: &mut Vec<T>, item: T, key: impl Fn(&T) -> K) {
    let wanted = key(&item);
    match items.iter_mut().find(|each| key(each) == wanted) {
        Some(existing) => *existing = item,
        None => items.push(item),
    }
}

fusor::template!("web/index.html");
