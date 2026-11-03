import { ComputePool, SPAWN_COMPUTE } from '../../vendor/fusor-ai/packages/host/compute.js';
import { Clauses } from './clauses.js';

// The engine bridge. The page's state lives in Rust (src/app.rs); this module owns the call: the
// three engine workers (engine/asr.js, llm.js, tts.js) and their compute workers (fusor-ai's
// ComputePool), the microphone's capture worklet and the speaker's playback worklet, and the
// turns between them. Each caller turn opens the floor; its endpoint closes it and starts the
// reply: the transcript goes to the LLM, each clause of the reply to the voice as soon as it is
// whole, and its frames to the speaker. Once the reply has played, the floor opens again. Each
// turn's marks (`performance.now()` times) go to the page, which turns them into its latency.

const params = new URLSearchParams(location.search);
const cores = navigator.hardwareConcurrency || 4;
// `?asr=`, `?llm=` and `?tts=` set an engine's threads. The LLM and the voice run at the same
// time, so their threads together stay below the cores: the barriers spin.
const threads = (name, fallback) => Math.min(cores, Number.parseInt(params.get(name) ?? '', 10) || fallback);
const ENGINES = {
  asr: { label: 'Parakeet Redux', model: 'model/parakeet/', threads: threads('asr', 4) },
  llm: { label: 'LFM3-1.7B', model: 'model/lfm3-1.7b/', threads: threads('llm', 6) },
  tts: { label: 'Phonon', model: 'model/phonon/', threads: threads('tts', 2) },
};
// `?endpoint=` (seconds of silence that end a turn) and `?level=` (the RMS of a voiced frame).
const ENDPOINT_SECONDS = Number.parseFloat(params.get('endpoint') ?? '') || 0.6;
const SPEECH_LEVEL = Number.parseFloat(params.get('level') ?? '') || 0.015;
const ASR_SAMPLE_RATE = 16_000;
const MAX_TOKENS = 160;
const SYSTEM = 'You are a friendly assistant on a phone call. Answer the way people talk: one to three short sentences of plain spoken English, never a list, markdown or emoji.';

const mb = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;
const seed = () => crypto.getRandomValues(new Uint32Array(1))[0];

export function onMount({ root, inputs, onCleanup }) {
  // Reports reach the page's state once per animation frame, the newest of each key.
  const reports = new Map();
  let frame = 0;
  const report = (key, detail) => {
    reports.set(key, detail);
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      for (const queued of reports.values()) root.dispatchEvent(new CustomEvent('engine', { detail: JSON.stringify(queued) }));
      reports.clear();
    });
  };
  const status = (text) => report('status', { type: 'status', status: text });
  const engines = {};
  const requests = { asr: 0, llm: 0, tts: 0 };
  let audio = null;
  let nextTurn = 1;
  let call = null;
  let broken = false;

  const HANDLERS = {
    asr: {
      text: ({ turn, text }) => current(turn) && report('hearing', { type: 'hearing', text }),
      final: transcribed,
    },
    llm: { reply: replied, done: replied },
    tts: {
      'first-audio': ({ turn, index }) => index === 0 && mark(current(turn), 'firstAudio'),
      spoken: ({ networkRequests }) => count('tts', networkRequests),
    },
  };

  const CAPTURE = {
    level: ({ rms }) => report('level', { type: 'level', level: rms / SPEECH_LEVEL }),
    speech: () => status('Hearing you…'),
    endpoint: ({ speechEnd }) => {
      const { turn } = call;
      turn.marks.endpoint = performance.now();
      turn.marks.speechEnd = turn.marks.endpoint - ENDPOINT_SECONDS * 1000;
      engines.asr.worker.postMessage({ type: 'finish', turn: turn.id, speechEnd });
      status('Thinking…');
    },
  };

  const PLAYBACK = {
    started: ({ job }) => {
      const turn = current(job);
      if (!turn) return;
      turn.marks.firstSound = performance.now() + call.output.outputLatency * 1000;
      send(turn);
      status('Speaking…');
    },
    drained: ({ job, gapSeconds }) => {
      const turn = current(job);
      if (!turn) return;
      turn.gap_seconds = gapSeconds;
      send(turn);
      listen();
    },
  };

  for (const [id, spec] of Object.entries(ENGINES)) start(id, spec);

  /** Starts engine `id`'s worker on its bundle; its messages go to its loading and `HANDLERS[id]`. */
  function start(id, { label, model, threads: count }) {
    const worker = new Worker(new URL(`engine/${id}.js`, document.baseURI), { type: 'module', name: `${id}-engine` });
    const pool = new ComputePool((message) => fail(`${label}: a compute thread stopped (${message})`));
    const shown = { id, label, fraction: 0, detail: `waiting for ${count} threads`, loaded: null };
    engines[id] = { worker, pool, shown };
    const routes = {
      ...loading(id),
      ...HANDLERS[id],
      [SPAWN_COMPUTE]: (message) => pool.spawn(message),
      warning: ({ message }) => console.warn(`${label}: ${message}`),
      error: ({ message }) => fail(`${label}: ${message}`),
      fatal: ({ message }) => fail(`${label}: ${message}`),
    };
    worker.onmessage = ({ data }) => {
      if (!broken) routes[data.type]?.(data);
    };
    worker.onerror = (event) => fail(`${label}: ${event.message || 'the engine worker failed'}`);
    worker.postMessage({ type: 'load', modelUrl: new URL(model, document.baseURI).href, threads: count, build: params.get('build') });
  }

  /** Engine `id`'s loading handlers; the page hears of the engine at once, so it waits for all three. */
  function loading(id) {
    const engine = engines[id];
    const update = () => report(`engine-${id}`, { type: 'engine', engine: { ...engine.shown } });
    update();
    return {
      runtime: ({ build, threads: count, sampleRate }) => {
        if (sampleRate) audio = prepareAudio(sampleRate);
        engine.started = { build, threads: count };
        engine.shown.detail = `${build} · loading`;
        update();
      },
      progress: ({ done, total }) => {
        engine.shown.fraction = done / total;
        engine.shown.detail = `${mb(done)} / ${mb(total)}`;
        update();
      },
      ready: ({ ms, cache, total, voices }) => {
        engine.shown.fraction = 1;
        engine.shown.loaded = { ...engine.started, bundle_bytes: total, load_ms: ms, from_device: cache === total };
        update();
        if (voices) report('voices', { type: 'voices', voices });
      },
    };
  }

  /**
   * The microphone's context at Parakeet's rate and the speaker's at Phonon's, with their worklets,
   * built while the models load and suspended until a call: a call fetches nothing.
   */
  async function prepareAudio(ttsSampleRate) {
    const input = new AudioContext({ sampleRate: ASR_SAMPLE_RATE, latencyHint: 'interactive' });
    const output = new AudioContext({ sampleRate: ttsSampleRate, latencyHint: 'interactive' });
    const worklet = (name) => new URL(`engine/${name}.js`, document.baseURI);
    await Promise.all([input.audioWorklet.addModule(worklet('capture')), output.audioWorklet.addModule(worklet('playback'))]);
    return { input, output };
  }

  async function startCall() {
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const { input, output } = await audio;
    const source = input.createMediaStreamSource(microphone);
    const capture = new AudioWorkletNode(input, 'call-capture', { outputChannelCount: [1] });
    source.connect(capture);
    capture.connect(input.destination);
    capture.port.onmessage = ({ data }) => CAPTURE[data.type](data);
    const playback = new AudioWorkletNode(output, 'call-playback', { outputChannelCount: [1] });
    playback.connect(output.destination);
    playback.port.onmessage = ({ data }) => PLAYBACK[data.type](data);
    const speaker = new MessageChannel();
    playback.port.postMessage({ type: 'engine', port: speaker.port1 }, [speaker.port1]);
    engines.tts.worker.postMessage({ type: 'audio', port: speaker.port2 }, [speaker.port2]);
    await Promise.all([input.resume(), output.resume()]);
    call = { microphone, source, input, output, capture, playback, turn: null, voice: root.querySelector('input[name=voice]:checked')?.value ?? 'default' };
    report('calling', { type: 'calling', active: true });
    listen();
  }

  function hangUp() {
    if (!call) return;
    const id = call.turn.id;
    call.capture.port.postMessage({ type: 'close' });
    call.microphone.getTracks().forEach((track) => track.stop());
    for (const node of [call.source, call.capture, call.playback]) node.disconnect();
    call.input.suspend();
    call.output.suspend();
    engines.asr.worker.postMessage({ type: 'stop' });
    engines.llm.worker.postMessage({ type: 'stop', job: id });
    engines.llm.worker.postMessage({ type: 'reset' });
    engines.tts.worker.postMessage({ type: 'stop', turn: id });
    call = null;
    report('calling', { type: 'calling', active: false });
    report('level', { type: 'level', level: 0 });
    status('Call ended.');
  }

  function toggle() {
    if (call) return hangUp();
    status('Asking for the microphone…');
    startCall().catch((error) => status(`No call: ${error?.message ?? error}`));
  }

  /** Gives the caller the floor: a new turn, heard by the ASR worker until its endpoint. */
  function listen() {
    const turn = { id: nextTurn++, caller: '', reply: '', marks: {}, clauses: new Clauses(), tokens: 0, gap_seconds: null, asr: null };
    call.turn = turn;
    const ears = new MessageChannel();
    call.capture.port.postMessage({ type: 'open', port: ears.port1, level: SPEECH_LEVEL, endpoint: ENDPOINT_SECONDS }, [ears.port1]);
    engines.asr.worker.postMessage({ type: 'listen', turn: turn.id, port: ears.port2 }, [ears.port2]);
    status('Listening: speak, then pause.');
  }

  function transcribed({ turn: id, text, reused, finishMs, networkRequests }) {
    const turn = current(id);
    if (!turn) return;
    count('asr', networkRequests);
    if (!text) return listen();
    turn.caller = text;
    turn.asr = reused ? 'streamed' : `finish() ${finishMs.toFixed(0)} ms`;
    report('hearing', { type: 'hearing', text: '' });
    mark(turn, 'transcript');
    call.playback.port.postMessage({ type: 'start', job: id });
    const message = { text, system: SYSTEM, thinking: false, mode: 'text', max_tokens: MAX_TOKENS, seed: seed() };
    engines.llm.worker.postMessage({ type: 'send', job: id, message: JSON.stringify(message) });
  }

  function replied({ type, job, answer, tokens, networkRequests }) {
    const turn = current(job);
    if (!turn) return;
    const done = type === 'done';
    if (tokens && !turn.marks.firstToken) turn.marks.firstToken = performance.now();
    turn.tokens = tokens;
    turn.reply = answer;
    for (const text of turn.clauses.take(answer, done)) {
      const index = turn.clauses.count - 1;
      if (index === 0) turn.marks.firstClause = performance.now();
      engines.tts.worker.postMessage({ type: 'speak', turn: job, index, text, voice: call.voice, seed: seed() });
    }
    if (done) {
      turn.marks.replyDone = performance.now();
      count('llm', networkRequests);
      engines.tts.worker.postMessage({ type: 'end', turn: job });
    }
    send(turn);
  }

  function mark(turn, name) {
    if (!turn) return;
    turn.marks[name] = performance.now();
    send(turn);
  }

  /** Reports a turn once its caller's words are known; a turn without them is not the call's. */
  function send(turn) {
    if (!turn.caller) return;
    const { clauses, ...shown } = turn;
    report(`turn-${turn.id}`, { type: 'turn', turn: { ...shown, marks: { ...turn.marks } } });
  }

  /** The call's current turn when it is turn `id`; messages of an ended turn are dropped. */
  function current(id) {
    return call?.turn?.id === id ? call.turn : null;
  }

  function count(id, networkRequests) {
    requests[id] = networkRequests;
    report('network', { type: 'network', requests: Object.values(requests).reduce((sum, value) => sum + value, 0) });
  }

  /** A model could not load, or an engine or a compute thread died: the page stops. */
  function fail(message) {
    hangUp();
    broken = true;
    terminate();
    report('broken', { type: 'broken', message });
  }

  function terminate() {
    for (const { worker, pool } of Object.values(engines)) {
      worker.terminate();
      pool.terminate();
    }
  }

  onCleanup(onClicks(inputs.calls, toggle));
  onCleanup(() => {
    hangUp();
    terminate();
    audio?.then(({ input, output }) => Promise.all([input.close(), output.close()]));
  });
}

/** Runs `action` once per click a click counter counts, clicks before this module loaded included. */
function onClicks(counter, action) {
  let seen = 0;
  return counter.subscribe((count) => {
    for (; seen < count; seen++) action();
  });
}
