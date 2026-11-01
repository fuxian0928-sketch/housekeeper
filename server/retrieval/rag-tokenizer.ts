import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Tokenizer } from "@huggingface/tokenizers";

export interface TokenCounter {
  readonly id: string;
  count(text: string): number;
}
/** Conservative packing fallback for unknown byte-based generation tokenizers. */
export const utf8ContextCounter: TokenCounter = {
  id: "utf8-byte-budget-v1",
  count(text) {
    return Buffer.byteLength(text, "utf8");
  },
};
let tokenizer: Tokenizer | undefined;
export const ragTokenizer: TokenCounter = {
  id: "BAAI/bge-m3@5617a9f:21106b6d",
  count(text) {
    if (!text) return 0;
    if (!tokenizer)
      tokenizer = new Tokenizer(
        JSON.parse(
          readFileSync(
            new URL("./assets/bge-m3-tokenizer.json", import.meta.url),
            "utf8",
          ),
        ),
        JSON.parse(
          readFileSync(
            new URL("./assets/bge-m3-tokenizer-config.json", import.meta.url),
            "utf8",
          ),
        ),
      );
    return tokenizer.encode(text, { add_special_tokens: false }).ids.length;
  },
};
export const ragHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function safeOffset(text: string, offset: number) {
  return offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset])
    ? offset - 1
    : offset;
}
export function tokenHead(
  text: string,
  budget: number,
  counter: TokenCounter = ragTokenizer,
): string {
  if (budget <= 0) return "";
  if (counter.count(text) <= budget) return text;
  let low = 0,
    high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (counter.count(text.slice(0, safeOffset(text, mid))) <= budget)
      low = mid;
    else high = mid - 1;
  }
  return text.slice(0, safeOffset(text, low));
}
export function tokenTail(
  text: string,
  budget: number,
  counter: TokenCounter = ragTokenizer,
): string {
  if (budget <= 0) return "";
  if (counter.count(text) <= budget) return text;
  let low = 0,
    high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2),
      start = safeOffset(text, text.length - mid);
    if (counter.count(text.slice(start)) <= budget) low = mid;
    else high = mid - 1;
  }
  return text.slice(safeOffset(text, text.length - low));
}
/** Token limits never require decode/re-encode, which could normalize source text. */
export function boundedSpans(
  text: string,
  start: number,
  end: number,
  budget: number,
  counter: TokenCounter = ragTokenizer,
) {
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = start;
  while (cursor < end) {
    const probeEnd = safeOffset(
        text,
        Math.min(end, cursor + Math.max(256, budget * 16)),
      ),
      probe = text.slice(cursor, probeEnd);
    let next = cursor + tokenHead(probe, budget, counter).length;
    if (next <= cursor)
      next = cursor + (text.codePointAt(cursor)! > 0xffff ? 2 : 1);
    if (next < end) {
      const segment = text.slice(cursor, next),
        boundaries = [
          ...segment.matchAll(/[。！？!?](?:[”’」』])?|\n|[.;](?=\s)/g),
        ];
      const candidate = boundaries.at(-1);
      if (
        candidate &&
        candidate.index! + candidate[0].length > segment.length * 0.55
      )
        next = cursor + candidate.index! + candidate[0].length;
    }
    spans.push({ start: cursor, end: next });
    cursor = next;
  }
  return spans;
}
