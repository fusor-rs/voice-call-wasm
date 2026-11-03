//! A turn's response latency, from the end of the caller's speech to the first sound of the
//! reply, as consecutive stages between the turn's marks, so the stages add up to the response.

use serde::Deserialize;

/// A turn's marks: `performance.now()` milliseconds on the page, set by `web/app.js` as the turn
/// reaches them.
#[derive(Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marks {
    // The last voiced frame, the endpoint's silence before the endpoint.
    speech_end: Option<f64>,
    endpoint: Option<f64>,
    transcript: Option<f64>,
    first_token: Option<f64>,
    first_clause: Option<f64>,
    first_audio: Option<f64>,
    // The first sample rendered, plus the output device's latency.
    first_sound: Option<f64>,
    reply_done: Option<f64>,
}

#[derive(Clone, Copy)]
enum Mark {
    SpeechEnd,
    Endpoint,
    Transcript,
    FirstToken,
    FirstClause,
    FirstAudio,
    FirstSound,
}

impl Mark {
    fn at(self, marks: &Marks) -> Option<f64> {
        match self {
            Self::SpeechEnd => marks.speech_end,
            Self::Endpoint => marks.endpoint,
            Self::Transcript => marks.transcript,
            Self::FirstToken => marks.first_token,
            Self::FirstClause => marks.first_clause,
            Self::FirstAudio => marks.first_audio,
            Self::FirstSound => marks.first_sound,
        }
    }
}

struct Stage {
    label: &'static str,
    note: &'static str,
    from: Mark,
    to: Mark,
}

impl Stage {
    fn ms(&self, marks: &Marks) -> Option<f64> {
        Some(self.to.at(marks)? - self.from.at(marks)?)
    }
}

/// The response, then the stages it is made of.
const STAGES: [Stage; 7] = [
    Stage {
        label: "Response",
        note: "the end of your speech to the first sound of the reply",
        from: Mark::SpeechEnd,
        to: Mark::FirstSound,
    },
    Stage {
        label: "Endpoint",
        note: "the silence that ends your turn",
        from: Mark::SpeechEnd,
        to: Mark::Endpoint,
    },
    Stage {
        label: "ASR",
        note: "the transcript after the endpoint",
        from: Mark::Endpoint,
        to: Mark::Transcript,
    },
    Stage {
        label: "LLM first token",
        note: "the prompt read and the first token drawn",
        from: Mark::Transcript,
        to: Mark::FirstToken,
    },
    Stage {
        label: "First clause",
        note: "the tokens until the first clause is whole",
        from: Mark::FirstToken,
        to: Mark::FirstClause,
    },
    Stage {
        label: "TTS first audio",
        note: "Phonon's first frame of that clause",
        from: Mark::FirstClause,
        to: Mark::FirstAudio,
    },
    Stage {
        label: "Playback",
        note: "to the speaker, its output latency included",
        from: Mark::FirstAudio,
        to: Mark::FirstSound,
    },
];

/// The column before the stages.
const TURN: (&str, &str) = ("Turn", "the caller's turns, in order");

/// The columns after the stages.
const MEASURES: [(&str, &str); 3] = [
    ("LLM tok/s", "tokens per second after the first"),
    (
        "Gaps",
        "silence inside the reply while the voice waited for text",
    ),
    (
        "ASR",
        "whether the streamed transcript already covered the end of speech",
    ),
];

/// One caller turn and its reply, as `web/app.js` reports it.
#[derive(Clone, PartialEq, Deserialize)]
pub struct Turn {
    pub id: u32,
    pub caller: String,
    pub reply: String,
    marks: Marks,
    tokens: u32,
    // Known once the reply has played to its end.
    gap_seconds: Option<f64>,
    asr: Option<String>,
}

impl Turn {
    pub fn played(&self) -> bool {
        self.gap_seconds.is_some()
    }

    /// Tokens per second after the first, once the reply is done.
    fn token_rate(&self) -> Option<f64> {
        let first = self.marks.first_token?;
        let done = self.marks.reply_done?;
        (self.tokens >= 2).then(|| f64::from(self.tokens - 1) * 1000.0 / (done - first))
    }

    pub fn cells(&self) -> Vec<Cell> {
        let stages = STAGES
            .iter()
            .map(|stage| milliseconds(stage.ms(&self.marks)));
        let measures = [
            rate(self.token_rate()),
            milliseconds(self.gap_seconds.map(|seconds| seconds * 1000.0)),
            self.asr.clone().unwrap_or_else(|| BLANK.into()),
        ];
        numbered(
            [self.id.to_string()]
                .into_iter()
                .chain(stages)
                .chain(measures),
        )
    }
}

#[derive(Clone, PartialEq)]
pub struct Header {
    pub index: usize,
    pub label: &'static str,
    pub note: &'static str,
}

#[derive(Clone, PartialEq)]
pub struct Cell {
    pub index: usize,
    pub text: String,
}

const BLANK: &str = "–";

pub fn headers() -> Vec<Header> {
    let stages = STAGES.iter().map(|stage| (stage.label, stage.note));
    let columns = [TURN].into_iter().chain(stages).chain(MEASURES).enumerate();
    columns
        .map(|(index, (label, note))| Header { index, label, note })
        .collect()
}

/// Each column's median over the turns played to their end.
pub fn medians(turns: &[Turn]) -> Vec<Cell> {
    let played: Vec<&Turn> = turns.iter().filter(|turn| turn.played()).collect();
    let title = format!("Median of {}", played.len());
    let stages = STAGES
        .iter()
        .map(|stage| milliseconds(median(played.iter().map(|turn| stage.ms(&turn.marks)))));
    let measures = [
        rate(median(played.iter().map(|turn| turn.token_rate()))),
        milliseconds(median(
            played
                .iter()
                .map(|turn| turn.gap_seconds.map(|seconds| seconds * 1000.0)),
        )),
        String::new(),
    ];
    numbered([title].into_iter().chain(stages).chain(measures))
}

fn numbered(texts: impl Iterator<Item = String>) -> Vec<Cell> {
    texts
        .enumerate()
        .map(|(index, text)| Cell { index, text })
        .collect()
}

fn milliseconds(value: Option<f64>) -> String {
    value.map_or_else(|| BLANK.into(), |ms| format!("{ms:.0} ms"))
}

fn rate(value: Option<f64>) -> String {
    value.map_or_else(|| BLANK.into(), |rate| format!("{rate:.0}"))
}

fn median(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    let mut sorted: Vec<f64> = values.flatten().collect();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    match sorted.len() {
        0 => None,
        count if count % 2 == 1 => Some(sorted[middle]),
        _ => Some((sorted[middle - 1] + sorted[middle]) / 2.0),
    }
}
