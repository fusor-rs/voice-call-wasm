---
license: other
license_name: mixed
license_link: https://huggingface.co/fusorlabs/voice-call-wasm-web/blob/main/README.md
base_model:
  - moondream/parakeet-redux
  - LiquidAI/LFM3-1.7B
  - gradium/phonon-31m-en
library_name: fusor-ai
tags:
  - webassembly
  - wasm
  - on-device
  - speech-recognition
  - text-generation
  - text-to-speech
---

# A voice call's three models, compiled for the browser

Three [fusor-ai](https://github.com/fusor-rs/fusor-ai) bundles, the weights the browser runtimes of
[voice-call-wasm](https://github.com/fusor-rs/voice-call-wasm) load to answer a voice call on the
device's CPU: not one speech-to-speech model but three working together. Try it in the Space
[fusorlabs/voice-call-wasm](https://huggingface.co/spaces/fusorlabs/voice-call-wasm).

| Folder | Model | Source | Profile | License |
| --- | --- | --- | --- | --- |
| `parakeet/` | Speech to text | `moondream/parakeet-redux` at `2bf128600aac4b16946f7ed8372e56117fe5e23b` | `ternary`: the encoder's 1.58-bit weights as published (199 MB) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), from NVIDIA's parakeet-tdt-0.6b-v3 |
| `lfm3-1.7b/` | The reply | `LiquidAI/LFM3-1.7B` at `40ebe0aa6662c9d40389c2f5d565b6a2c6aebacd` | `q7`: every large matrix 7-bit (1964 MB) | LFM Open License v1.0 ([lfm3-1.7b/LICENSE](lfm3-1.7b/LICENSE)) |
| `phonon/` | Text to speech | `gradium/phonon-31m-en` at `52433c46975bfa13144c56204c9f4ee1c5b148aa`, voices from `gradium/phonon-voices` at `0ee17205f254b5abc43b266c8a0f215565c352f7` | `q7` (46 MB) | Apache-2.0 |

- **Format:** each folder's `manifest.json` lists every tensor and part; each part is named by its
  BLAKE3 hash, which the runtime checks as it loads.
- **Reproduce it:** `just model` in voice-call-wasm downloads the checkpoints and compiles the same
  bundles.

These are not PyTorch or safetensors checkpoints: they only load in the voice-call-wasm runtimes
built with the same fusor-ai.
