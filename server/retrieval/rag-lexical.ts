import { createHash } from "node:crypto";
export function lexicalTerms(text: string) {
  const normalized = text.normalize("NFKC").toLowerCase(),
    terms: string[] = [...(normalized.match(/[a-z0-9_.:@/-]+/g) ?? [])];
  for (const segment of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const characters = [...segment];
    if (characters.length === 1) terms.push(segment);
    else
      for (let index = 0; index < characters.length - 1; index++)
        terms.push(characters.slice(index, index + 2).join(""));
  }
  return terms.filter((term) => term.length > 0 && term.length <= 160);
}
export function hashVector(text: string) {
  const vector = new Array<number>(256).fill(0);
  for (const term of lexicalTerms(text)) {
    const hash = createHash("sha256").update(term).digest();
    vector[hash.readUInt16BE(0) % 256] += hash[2] % 2 ? 1 : -1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}
export function finiteVector(
  value: unknown,
  dimension: number,
): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dimension &&
    value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
    value.some((item) => item !== 0)
  );
}
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) return -1;
  let product = 0,
    aa = 0,
    bb = 0;
  for (let index = 0; index < a.length; index++) {
    product += a[index] * b[index];
    aa += a[index] * a[index];
    bb += b[index] * b[index];
  }
  return aa && bb ? product / Math.sqrt(aa * bb) : -1;
}
