// The ears: Parakeet Redux in a module Worker. While the caller has the floor, the capture
// worklet posts 16 kHz audio straight here through a MessagePort and every `MIN_FRESH_SECONDS`
// of new audio is transcribed again, so at the end of the turn the transcript is usually ready:
// when the last update already heard past the end of speech, that update is the transcript, and
// only otherwise does `finish()` read the rest.

import { engine, load, post, requestsSinceReady, serve, yieldTask } from './dist/host/worker.js';

const MIN_FRESH_SECONDS = 0.5;

let sampleRate = 0;
let live = null;

serve({
  load: ({ modelUrl, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'parakeet_runtime',
      cacheName: 'voice-call-parakeet',
      distUrl: new URL('./dist/parakeet/', import.meta.url),
      onRuntime: (started) => {
        sampleRate = started.glue.sample_rate();
        post({ type: 'runtime', build: started.build.name, threads: started.threads });
      },
      onReady: (progress) => post({ type: 'ready', ...progress }),
    }),
  listen,
  finish,
  stop: () => close(),
});

function listen({ turn, port }) {
  close();
  engine.rt.listen();
  const session = { turn, port, fresh: 0, committed: [], provisional: [], heard: 0, running: false };
  port.onmessage = ({ data: samples }) => {
    engine.rt.hear(samples);
    session.fresh += samples.length;
    pump(session);
  };
  live = session;
}

function close() {
  live?.port.close();
  const session = live;
  live = null;
  return session;
}

/** Transcribes `session` again while enough new audio keeps arriving, one update per macrotask. */
async function pump(session) {
  if (session.running) return;
  session.running = true;
  try {
    while (live === session && session.fresh >= MIN_FRESH_SECONDS * sampleRate) {
      session.fresh = 0;
      take(session, JSON.parse(engine.rt.update()));
      post({ type: 'text', turn: session.turn, text: transcript(session) });
      await yieldTask();
    }
  } finally {
    session.running = false;
  }
}

/** The turn's transcript, `speechEnd` seconds after listening began being the end of speech. */
async function finish({ turn, speechEnd }) {
  const session = close();
  if (session?.turn !== turn) return;
  while (session.running) await yieldTask();
  const t0 = performance.now();
  const reused = session.heard >= speechEnd;
  if (!reused) take(session, JSON.parse(engine.rt.finish()));
  const finishMs = performance.now() - t0;
  post({ type: 'final', turn, text: transcript(session), reused, finishMs, networkRequests: requestsSinceReady() });
}

function take(session, update) {
  session.committed.push(...update.committed);
  session.provisional = update.provisional;
  session.heard = update.heard;
}

const transcript = (session) => [...session.committed, ...session.provisional].map((sentence) => sentence.text.trim()).join(' ');
