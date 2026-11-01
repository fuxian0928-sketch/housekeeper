const endings = /[。！？!?；;\n]/g;
const closers = /[”’」』）)\]]/;
const token = /[\dA-Za-z_.:+/@%=-]/;

/** Public answer text only. First sentence is immediate; later sentences can
 * coalesce briefly, while dates, decimals and identifiers retain their boundary. */
export class SpeechTextChunker {
  private pending = '';
  private first = true;
  get hasComplete() { return this.boundaries().length > 0; }
  private boundaries() {
    const result: number[] = [];
    endings.lastIndex = 0;
    for (const match of this.pending.matchAll(endings)) {
      let end = match.index! + 1;
      while (end < this.pending.length && closers.test(this.pending[end])) end++;
      result.push(end);
    }
    // A terminal streamed dot could still become a decimal or identifier.
    for (let i = 1; i < this.pending.length - 1; i++) if (this.pending[i] === '.' && /\s/.test(this.pending[i + 1]) && !/\d/.test(this.pending[i - 1])) result.push(i + 1);
    return result.sort((a, b) => a - b);
  }
  private boundedCut() {
    const candidates = [...this.pending.slice(0, 101).matchAll(/[，,：:、\s]/g)].map(m => m.index! + 1).filter(i => i >= 24 && !(token.test(this.pending[i - 2] ?? '') && token.test(this.pending[i] ?? '')));
    if (candidates.length) return candidates.at(-1)!;
    let cut = 100;
    if (token.test(this.pending[cut - 1]) && token.test(this.pending[cut])) {
      let start = cut, end = cut;
      while (start > 0 && token.test(this.pending[start - 1])) start--;
      while (end < this.pending.length && token.test(this.pending[end])) end++;
      if (start >= 24) cut = start;
      else if (end <= 160) cut = end;
    }
    // Never divide a UTF-16 surrogate pair.
    if (cut > 0 && /[\uD800-\uDBFF]/.test(this.pending[cut - 1])) cut--;
    return cut;
  }
  push(text: string) { this.pending += text; return this.take(); }
  take(forceComplete = false) {
    const chunks: string[] = [];
    while (this.pending.length) {
      const boundaries = this.boundaries(), bounded = boundaries.filter(end => end <= 100);
      let cut = 0;
      if (bounded.length && (this.first || forceComplete || this.pending.length >= 64)) cut = this.first ? bounded[0] : bounded.at(-1)!;
      else if (this.pending.length > 100) cut = this.boundedCut();
      if (!cut) break;
      const text = this.pending.slice(0, cut); this.pending = this.pending.slice(cut);
      if (text.trim()) { chunks.push(text); this.first = false; }
    }
    return chunks;
  }
  finish() {
    const chunks = this.take(true);
    if (this.pending.trim()) chunks.push(this.pending);
    this.pending = '';
    return chunks;
  }
}
