// The microphone's audio worklet, in a context at Parakeet's 16 kHz. The call is half duplex:
// the page opens the floor for each caller turn (`open`, with the port of the ASR worker's
// listening session) and nothing is heard while the assistant speaks.
//
// While open, the audio, channels averaged, goes to the ASR worker in pieces of `PIECE_SECONDS`,
// and every `FRAME_SECONDS` frame is judged voiced when its RMS reaches `level`. Once the caller
// has spoken for `MIN_SPEECH_SECONDS` and then been silent for `endpoint` seconds, the turn ends:
// the page hears `endpoint` with `speechEnd`, the seconds of audio sent up to the last voiced
// frame, and the floor closes. The page also hears each frame's level.

const PIECE_SECONDS = 0.1;
const FRAME_SECONDS = 0.02;
const MIN_SPEECH_SECONDS = 0.1;
const PIECE_SAMPLES = Math.round(PIECE_SECONDS * sampleRate);
const FRAME_SAMPLES = Math.round(FRAME_SECONDS * sampleRate);

class Capture extends AudioWorkletProcessor {
  #engine = null;
  #level = 0;
  #endpointSamples = 0;
  #piece = new Float32Array(PIECE_SAMPLES);
  #filled = 0;
  #sent = 0;
  #energy = 0;
  #voicedSamples = 0;
  #voicedEnd = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'open') this.#open(data);
      else if (data.type === 'close') this.#close();
    };
  }

  #open({ port, level, endpoint }) {
    this.#engine = port;
    this.#level = level;
    this.#endpointSamples = Math.round(endpoint * sampleRate);
    this.#filled = 0;
    this.#sent = 0;
    this.#energy = 0;
    this.#voicedSamples = 0;
    this.#voicedEnd = 0;
  }

  #close() {
    this.#engine?.close();
    this.#engine = null;
  }

  process([channels]) {
    if (!channels.length || !this.#engine) return true;
    for (let i = 0; i < channels[0].length && this.#engine; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      this.#take(sample);
    }
    return true;
  }

  #take(sample) {
    this.#piece[this.#filled++] = sample;
    this.#sent++;
    if (this.#filled === PIECE_SAMPLES) {
      // Transferring the piece detaches it: the next one is new.
      this.#engine.postMessage(this.#piece, [this.#piece.buffer]);
      this.#piece = new Float32Array(PIECE_SAMPLES);
      this.#filled = 0;
    }
    this.#energy += sample * sample;
    if (this.#sent % FRAME_SAMPLES === 0) this.#judgeFrame();
  }

  #judgeFrame() {
    const rms = Math.sqrt(this.#energy / FRAME_SAMPLES);
    this.#energy = 0;
    this.port.postMessage({ type: 'level', rms });
    if (rms >= this.#level) {
      this.#voicedSamples += FRAME_SAMPLES;
      this.#voicedEnd = this.#sent;
      if (this.#voicedSamples === FRAME_SAMPLES) this.port.postMessage({ type: 'speech' });
      return;
    }
    const spoke = this.#voicedSamples >= MIN_SPEECH_SECONDS * sampleRate;
    if (spoke && this.#sent - this.#voicedEnd >= this.#endpointSamples) {
      this.port.postMessage({ type: 'endpoint', speechEnd: this.#voicedEnd / sampleRate });
      this.#close();
    }
  }
}

registerProcessor('call-capture', Capture);
