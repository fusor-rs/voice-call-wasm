// Word error rate of a transcript against the text that was spoken, both normalized the same way:
// lowercase, hyphens as spaces, punctuation dropped (apostrophes kept).

function words(text) {
  const plain = text.toLowerCase().replace(/-/g, ' ').replace(/[^\p{L}\p{N}' ]/gu, ' ');
  return plain.split(/\s+/).filter(Boolean);
}

/** Substitutions, deletions and insertions over the reference's words. */
export function wordErrorRate(reference, transcript) {
  const [want, got] = [words(reference), words(transcript)];
  let previous = Array.from({ length: got.length + 1 }, (_, j) => j);
  for (let i = 1; i <= want.length; i++) {
    const row = [i];
    for (let j = 1; j <= got.length; j++) {
      const substitution = previous[j - 1] + (want[i - 1] === got[j - 1] ? 0 : 1);
      row.push(Math.min(substitution, previous[j] + 1, row[j - 1] + 1));
    }
    previous = row;
  }
  return previous[got.length] / Math.max(1, want.length);
}
