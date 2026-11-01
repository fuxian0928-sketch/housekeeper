/** Identical write/query segmentation; no native dependency or network on the voice path. */
export function memoryTokens(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9_.-]+/g) ?? []);
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens];
}
export const memorySearchText = (text: string) => memoryTokens(text).join(' ');
export const memoryFtsQuery = (text: string) => memoryTokens(text).slice(0, 24).map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ');
