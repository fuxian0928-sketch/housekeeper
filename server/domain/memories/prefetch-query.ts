/** Preserve word boundaries, operators and internal punctuation. Only tolerate
 * case, repeated whitespace and a trailing sentence terminator from ASR. */
export const normalizePrefetchQuery = (text: string) => text.trim().toLowerCase()
  .replace(/\s+/gu, ' ').replace(/[。！？!?]+$/u, '').trim();
