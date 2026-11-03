// The brain: LFM3-1.7B in a module Worker, holding the call's conversation. Each caller turn is
// the conversation's next message; one `step()` per macrotask (the prompt, then a token at a
// time) posts the reply so far, so the page can hand finished clauses to the voice while the
// rest is still being written.

import { engine, load, post, requestsSinceReady, serve, yieldTask } from './dist/host/worker.js';

const NO_MEDIA = JSON.stringify({ images: [], clips: [] });

let stoppedJob = null;

serve({
  load: ({ modelUrl, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'lfm3_runtime',
      cacheName: 'voice-call-lfm3',
      distUrl: new URL('./dist/lfm3/', import.meta.url),
      onRuntime: (started) => post({ type: 'runtime', build: started.build.name, threads: started.threads }),
      onReady: (progress) => post({ type: 'ready', ...progress }),
    }),
  send,
  stop: ({ job }) => (stoppedJob = job),
  reset: () => engine.rt.reset(),
});

async function send({ job, message }) {
  const { rt } = engine;
  const plan = JSON.parse(rt.start(message, new Uint8Array(), new Float32Array(), NO_MEDIA));
  post({ type: 'started', job, promptTokens: plan.prompt_tokens });
  for (;;) {
    await yieldTask();
    if (stoppedJob === job) {
      rt.cancel();
      return;
    }
    const progress = JSON.parse(rt.step());
    const reply = { job, answer: progress.answer, tokens: progress.tokens, networkRequests: requestsSinceReady() };
    post({ type: progress.done ? 'done' : 'reply', ...reply });
    if (progress.done) return;
  }
}
