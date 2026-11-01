import identity from '../assistant-identity.json';

export const ASSISTANT_NAME = identity.displayName;
export const DEFAULT_WAKE_WORD = identity.defaultWakeWord;
export const DEFAULT_VOICE_FAREWELL = identity.defaultFarewellText;
export const BUILT_IN_WAKE_PHRASES = [...identity.defaultWakePhrases, ...identity.legacyWakePhrases];

export function readWakeWord(config: {wakeWord?: string}): string {
  const word = config.wakeWord;
  return word === undefined || identity.legacyDefaultWakeWords.some(legacy => legacy.toLowerCase() === word.replace(/\s/gu, '').toLowerCase()) ? DEFAULT_WAKE_WORD : word;
}
