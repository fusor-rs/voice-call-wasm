# AGENTS.md

Rules for coding agents in this repository that are its own. fusor-ai's
`vendor/fusor-ai/AGENTS.md` is the standard and binds here too (`CLAUDE.md`
imports both); this file adds what is particular to this product.

voice-call-wasm is a voice call answered in the browser on the CPU, sealed from
the network, by three models in turn: Parakeet Redux (speech to text), LFM3-1.7B
(the reply) and Phonon (text to speech). It is not a speech-to-speech model and
doesn't become one: each model is its own fusor-ai runtime in its own worker. The
page exists to measure a call's latency honestly. The README describes what it
does; don't invent scope, features or options beyond the task.

## Repository

- `vendor/fusor-ai/models/{parakeet,lfm3,phonon}`: the three models, their
  compilers, runtimes and CLIs, in fusor-ai. Each has its own product repository
  (parakeet-redux-wasm, liquidai-lmf3-wasm, phonon-wasm); this one only chains them.
- `app/`: the page, a [fusor](https://github.com/fusor-rs/fusor) app with its own
  Cargo workspace: the engines' load, the call and its turns as Rust signals in
  `src/app.rs`, each turn's latency stages in `src/latency.rs`, the template in
  `web/index.html` on fusor-ai's `packages/ui/base.css`, the call itself in
  `web/app.js` (the turn's marks, the half-duplex floor) and `web/clauses.js` (the
  reply cut into what the voice reads), and in `engine/` one worker per model on
  fusor-ai's worker kit (`asr.js`, `llm.js`, `tts.js`) and the capture and
  playback worklets, beside the runtimes `just runtimes` builds.
- `scripts/fetch-checkpoints.sh`: the three checkpoints, pinned as the models' own
  products pin them; `scripts/node-smoke.mjs`: the three runtimes chained in Node;
  `e2e/run.mjs`: a call in headless Chrome on fusor-ai's e2e kit, with a fake
  microphone; `scripts/wer.mjs`: the word error rate both check.
- `fixtures/caller.txt`: the caller's lines; `just fixtures` speaks them with
  Phonon's CLI into `fixtures/calls/` (not committed).
- `assets/`: the README's banner and flow diagram, HTML rendered to PNG by
  `just images`.

What belongs where: model code and anything another model could reuse go to
fusor-ai, following its `AGENTS.md`. This repository holds what turns the models
into a call: the page, its checks and its measurements. A change to fusor-ai lands
there first; this repository never patches it.

Constraints that hold everywhere:

- fusor-ai comes only from `vendor/fusor-ai`, never a crates.io version, a
  `[patch]` table or a sibling checkout. The submodule moves to another pushed
  fusor-ai commit in a change of its own. No copies of fusor-ai code here.
- The page owns every capability: caching the bundles (OPFS), the microphone, the
  speaker and measuring itself. The runtimes do no I/O.
- The latency is measured, never estimated: every stage is the time between two
  marks the page took, and the stages add up to the response. A change that adds
  a stage adds its mark.
- The e2e's thresholds (`MAX_WER`) and the smoke test's
  (`MAX_WORD_ERROR_RATE`) are never loosened.

## Checks

A change is done only when this passes:

```sh
just check
```

It runs formatting and Clippy on the page and syntax checks of the scripts;
fusor-ai's `just check` covers the runtimes and the CLIs. A change to the page or
fusor-ai also needs `just runtimes`, `just smoke` and `just e2e`.
