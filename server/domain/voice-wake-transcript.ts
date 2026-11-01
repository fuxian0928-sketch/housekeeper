const DEFAULT_WAKE = /^(?:(?:希微){1,2}|(?:小[e伊艺易衣姨一]){1,2})$/u;
const SPOKEN_WAKE = /^(?:(?:希微){1,2}|(?:小[e伊艺易衣姨一]){1,2})/u;
// The bundled Mandarin recognizer can transcribe the acoustic wake as e.g.
// “西威西威”. Match only these same-name spellings, at an opening address;
// do not turn this into an unrestricted pinyin/substring search.
const NEAR_NAME = /^(?:[希西曦稀熹细][微薇维威]){1,2}(.*)$/u;
// In the actual KWS -> AEC -> bundled ASR round trip, the first repetition can
// become “戚薇” while the second remains “西威”. Require that second name;
// a standalone celebrity name or a later mention is never a wake confirmation.
const REPEATED_NAME_REPAIR = /^戚薇(?:[希西曦稀熹细][微薇维威])(.*)$/u;
const DIRECT_ADDRESS_TAIL = /^(?:$|[，。！？、,.!?\s]|请|麻烦|帮我|你(?:好|在|能|可)|在吗|听得到|听得见)/u;

export function isBuiltInWakeWord(value: string): boolean {
  return DEFAULT_WAKE.test(value.replace(/\s/gu, '').toLowerCase());
}

function compact(value: string): string {
  return value.trim().replace(/^[嗯啊呃喂，。！？、,.!?\s]+/gu, '').replace(/[，。！？、,.!?\s]/gu, '').toLowerCase();
}

/** Confirm an acoustic wake from the same turn's ASR result before answering. */
export function acceptsWakeTranscript(transcript: string, configuredWord: string): boolean {
  const heard = compact(transcript);
  const wake = configuredWord.replace(/\s/gu, '').toLowerCase();
  if (!heard || !wake) return false;
  if (DEFAULT_WAKE.test(wake)) {
    if (SPOKEN_WAKE.test(heard)) return true;
    // Near-name ASR forms are allowed only as an opening direct address after
    // an acoustic wake, never as broad pinyin matches such as “细微差别”.
    const opening = transcript.trim().replace(/^[嗯啊呃喂，。！？、,.!?\s]+/gu, '');
    const addressed = opening.match(NEAR_NAME) ?? opening.match(REPEATED_NAME_REPAIR);
    return Boolean(addressed && DIRECT_ADDRESS_TAIL.test(addressed[1]));
  }
  return heard.startsWith(wake);
}
