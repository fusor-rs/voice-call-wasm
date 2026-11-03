// The voice: Phonon in a module Worker. The page queues a turn's clauses as the reply is written
// (`speak`) and then its `end`; they are synthesized in order, one `step()` (an 80 ms frame) per
// macrotask, and every frame's PCM goes straight to the playback worklet through `audioPort`, the
// turn's `end` after its last clause.

import { engine, load, post, requestsSinceReady, serve, yieldTask } from './dist/host/worker.js';

const queue = [];
let audioPort = null;
let stoppedTurn = null;
let speaking = false;

serve({
  load: ({ modelUrl, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'phonon_runtime',
      cacheName: 'voice-call-phonon',
      distUrl: new URL('./dist/phonon/', import.meta.url),
      onRuntime: (started) => post({ type: 'runtime', build: started.build.name, threads: started.threads, sampleRate: started.glue.sample_rate() }),
      onReady: (progress) => post({ type: 'ready', voices: JSON.parse(engine.glue.voices()), ...progress }),
    }),
  audio: ({ port }) => (audioPort = port),
  speak: (clause) => enqueue(clause),
  end: (end) => enqueue({ ...end, end: true }),
  stop: ({ turn }) => (stoppedTurn = turn),
});

function enqueue(item) {
  queue.push(item);
  drain();
}

async function drain() {
  if (speaking) return;
  speaking = true;
  try {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (item.turn === stoppedTurn) continue;
      if (item.end) audioPort.postMessage({ type: 'end', job: item.turn });
      else await synthesize(item);
    }
  } finally {
    speaking = false;
  }
}

/** Speaks clause `index` of `turn`, frame by frame, until its end or the turn's stop. */
async function synthesize({ turn, index, text, voice, seed }) {
  const { rt } = engine;
  const t0 = performance.now();
  let firstAudioMs = null;
  let samples = 0;
  rt.start(JSON.stringify({ text, voice, seed }));
  for (;;) {
    if (stoppedTurn === turn) {
      rt.cancel();
      return;
    }
    const progress = JSON.parse(rt.step());
    const pcm = rt.take_audio();
    if (pcm.length) {
      if (firstAudioMs === null) {
        firstAudioMs = performance.now() - t0;
        post({ type: 'first-audio', turn, index, firstAudioMs });
      }
      samples += pcm.length;
      audioPort.postMessage({ type: 'pcm', job: turn, samples: pcm }, [pcm.buffer]);
    }
    if (progress.done) break;
    await yieldTask();
  }
  post({ type: 'spoken', turn, index, samples, wallMs: performance.now() - t0, networkRequests: requestsSinceReady() });
}
