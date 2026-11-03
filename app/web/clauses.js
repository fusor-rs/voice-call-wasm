// Cuts a reply, as it streams in, into the pieces the voice reads, each as soon as it is whole:
// the first at its first clause boundary once it has `FIRST_CLAUSE_WORDS` words (the sooner the
// voice starts, the sooner the caller hears an answer), the rest at sentence ends. A boundary
// counts only once the text after it has begun, so "3.5" is not cut at its point.

const SENTENCE_END = /[.!?…]+["')\]]*\s+/g;
const CLAUSE_END = /[,;:—]\s+/g;
const FIRST_CLAUSE_WORDS = 4;
// Markdown the system prompt asks the model not to write, which the voice would read aloud.
const MARKUP = /[*_#`]/g;

export class Clauses {
  #taken = 0;
  #pieces = 0;

  /** The new pieces of `answer`, the reply so far; once it is `done`, its rest too. */
  take(answer, done) {
    const pieces = [];
    for (let end = this.#boundary(answer); end !== null; end = this.#boundary(answer)) {
      this.#push(pieces, answer.slice(this.#taken, end));
      this.#taken = end;
    }
    if (done) {
      this.#push(pieces, answer.slice(this.#taken));
      this.#taken = answer.length;
    }
    return pieces;
  }

  get count() {
    return this.#pieces;
  }

  #push(pieces, text) {
    const piece = text.replace(MARKUP, '').trim();
    if (!piece) return;
    pieces.push(piece);
    this.#pieces++;
  }

  /** Where the next piece of `answer` ends, or null while it is still unfinished. */
  #boundary(answer) {
    const rest = answer.slice(this.#taken);
    const candidates = [firstEnd(rest, SENTENCE_END, 0)];
    if (this.#pieces === 0) candidates.push(firstEnd(rest, CLAUSE_END, FIRST_CLAUSE_WORDS));
    const ends = candidates.filter((end) => end !== null);
    return ends.length ? this.#taken + Math.min(...ends) : null;
  }
}

/** Where the first `boundary` in `text` with `minWords` words before it ends, or null. */
function firstEnd(text, boundary, minWords) {
  for (const match of text.matchAll(boundary)) {
    if (words(text.slice(0, match.index)) >= minWords) return match.index + match[0].length;
  }
  return null;
}

const words = (text) => text.split(/\s+/).filter(Boolean).length;
