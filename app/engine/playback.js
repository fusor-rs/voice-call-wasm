// The speaker's audio worklet, in a context at Phonon's rate. The TTS worker posts each frame's
// PCM straight here through the port the page hands to both, and the render thread plays a turn's
// clauses back to back from its first frame on.
//
// Messages, each tagged with its turn (`job`; anything from another turn is dropped): `start`
// and `flush` from the page, `pcm` and `end` (no more samples) from the TTS worker. The page
// hears `started` (the turn's first sample was rendered) and `drained` (everything was played,
// with `gapSeconds`, the silence while the queue was dry between the first sample and the end).

class Playback extends AudioWorkletProcessor {
  #job = -1;
  #chunks = [];
  #offset = 0;
  #ended = false;
  #started = false;
  #gapSamples = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'engine') data.port.onmessage = ({ data: message }) => this.#receive(message);
      else this.#receive(data);
    };
  }

  #receive({ type, job, samples }) {
    if (type === 'start') {
      this.#job = job;
      this.#chunks = [];
      this.#offset = 0;
      this.#ended = false;
      this.#started = false;
      this.#gapSamples = 0;
      return;
    }
    if (job !== this.#job) return;
    if (type === 'pcm') this.#chunks.push(samples);
    else if (type === 'end') this.#ended = true;
    else if (type === 'flush') this.#job = -1;
  }

  process(_inputs, [[out]]) {
    if (this.#job < 0) return true;
    const written = this.#fill(out);
    if (written && !this.#started) {
      this.#started = true;
      this.port.postMessage({ type: 'started', job: this.#job });
    }
    if (written === out.length) return true;
    if (this.#ended) {
      this.port.postMessage({ type: 'drained', job: this.#job, gapSeconds: this.#gapSamples / sampleRate });
      this.#job = -1;
    } else if (this.#started) {
      this.#gapSamples += out.length - written;
    }
    return true;
  }

  #fill(out) {
    let written = 0;
    while (written < out.length && this.#chunks.length) {
      const chunk = this.#chunks[0];
      const count = Math.min(out.length - written, chunk.length - this.#offset);
      out.set(chunk.subarray(this.#offset, this.#offset + count), written);
      written += count;
      this.#offset += count;
      if (this.#offset === chunk.length) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
    out.fill(0, written);
    return written;
  }
}

registerProcessor('call-playback', Playback);
