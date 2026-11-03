---
title: voice-call-wasm
short_description: A voice call answered by three models on your CPU
sdk: static
app_file: index.html
pinned: false
license: mit
models:
  - fusorlabs/voice-call-wasm-web
  - moondream/parakeet-redux
  - LiquidAI/LFM3-1.7B
  - gradium/phonon-31m-en
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

A voice call computed on your own CPU in the browser, by three models working together rather than
one speech-to-speech model: [Moondream Parakeet Redux](https://huggingface.co/moondream/parakeet-redux)
writes down what you say while you say it, [LFM3-1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B)
writes the answer, and [Phonon](https://huggingface.co/gradium/phonon-31m-en) speaks each clause of
it while the rest is still being written. Each model, compiled to WebAssembly with fusor-ai, downloads
once from [fusorlabs/voice-call-wasm-web](https://huggingface.co/fusorlabs/voice-call-wasm-web) and
then runs sealed from the network; nothing you say leaves the page. Every turn is timed from the end
of your sentence to the first sound of the reply. Parakeet Redux is CC-BY-4.0, LFM3-1.7B is under the
LFM Open License v1.0 (its license ships beside its bundle) and Phonon is Apache-2.0. The page's code
is MIT; its source is [github.com/fusor-rs/voice-call-wasm](https://github.com/fusor-rs/voice-call-wasm).
