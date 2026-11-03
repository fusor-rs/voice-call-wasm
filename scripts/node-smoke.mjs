// Runs the call's three single-threaded runtime builds in Node against their bundles, each part
// pushed the way the browser loader pushes it, and chains them as a turn does: LFM3-1.7B answers
// the caller's first line, Phonon speaks the answer, and Parakeet Redux, hearing that speech, must
// write the answer's words back.
//
//   node scripts/node-smoke.mjs dist/model --build web-single

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { wordErrorRate } from './wer.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    build: { type: 'string', default: 'web-single' },
  },
});
const bundles = positionals[0] ?? 'dist/model';
const CHUNK = 8 << 20;
const MAX_TOKENS = 80;
const NO_MEDIA = JSON.stringify({ images: [], clips: [] });
// Phonon's speech, heard back by Parakeet, as a share of the answer's words.
const MAX_WORD_ERROR_RATE = 0.15;
const question = readFileSync(new URL('../fixtures/caller.txt', import.meta.url), 'utf8').split('\n')[0];

/** The runtime of `crate` with the bundle in `bundles/<bundle>` loaded, and its glue. */
async function load(crate, bundle) {
  const dist = new URL(`../app/engine/dist/${crate}/${values.build}/`, import.meta.url);
  const glue = await import(new URL(`${crate}_runtime.js`, dist));
  glue.initSync({ module: readFileSync(new URL(`${crate}_runtime_bg.wasm`, dist)) });
  const t0 = performance.now();
  const manifest = readFileSync(join(bundles, bundle, 'manifest.json'), 'utf8');
  const runtime = new glue.Runtime(manifest);
  let ready = false;
  JSON.parse(manifest).parts.forEach((part, index) => {
    const bytes = readFileSync(join(bundles, bundle, part.file));
    for (let offset = 0; offset < bytes.length; offset += CHUNK) runtime.write_part(index, bytes.subarray(offset, offset + CHUNK));
    ready = runtime.end_part(index);
  });
  if (!ready) throw new Error(`${bundle}: engine not ready after every part`);
  console.log(`${values.build} ${bundle}: load ${seconds(performance.now() - t0)}`);
  return { runtime, glue };
}

/** Steps `runtime` until a step is done; returns the last step's progress. */
function steps(runtime, each = () => {}) {
  for (;;) {
    const progress = JSON.parse(runtime.step());
    each(progress);
    if (progress.done) return progress;
  }
}

/** `samples` at `from` Hz, linearly interpolated to `to` Hz. */
function resample(samples, from, to) {
  const out = new Float32Array(Math.floor((samples.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const position = (i * from) / to;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    out[i] = samples[left] + (samples[right] - samples[left]) * (position - left);
  }
  return out;
}

const seconds = (ms) => `${(ms / 1000).toFixed(2)}s`;
const timed = (label, work) => {
  const t0 = performance.now();
  const result = work();
  console.log(`${label} in ${seconds(performance.now() - t0)}`);
  return result;
};

const llm = await load('lfm3', 'lfm3-1.7b');
const tts = await load('phonon', 'phonon');
const asr = await load('parakeet', 'parakeet');

const message = JSON.stringify({ text: question, thinking: false, mode: 'text', max_tokens: MAX_TOKENS, seed: 1 });
llm.runtime.start(message, new Uint8Array(), new Float32Array(), NO_MEDIA);
const { answer, tokens } = timed('LFM3-1.7B answered', () => steps(llm.runtime));
console.log(`  ${tokens} tokens: ${answer}`);

const chunks = [];
tts.runtime.start(JSON.stringify({ text: answer, voice: 'default', seed: 1 }));
timed('Phonon spoke it', () => steps(tts.runtime, () => chunks.push(tts.runtime.take_audio())));
const speech = Float32Array.from(chunks.flatMap((chunk) => [...chunk]));
console.log(`  ${(speech.length / tts.glue.sample_rate()).toFixed(1)} s of speech`);

const sentences = [];
asr.runtime.start(resample(speech, tts.glue.sample_rate(), asr.glue.sample_rate()));
timed('Parakeet Redux heard it', () => steps(asr.runtime, (progress) => sentences.push(...progress.sentences)));
const heard = sentences.map((sentence) => sentence.text.trim()).join(' ');
const rate = wordErrorRate(answer, heard);
console.log(`  ${heard}\n  word error rate ${rate.toFixed(3)}`);
if (rate > MAX_WORD_ERROR_RATE) throw new Error(`heard ${rate.toFixed(3)} of the answer's words wrong, more than ${MAX_WORD_ERROR_RATE}`);
