import { pinyin } from 'pinyin-pro';
import { acceptsWakeTranscript, isBuiltInWakeWord } from '../../../server/domain/voice-wake-transcript';

function syllables(value: string): string[] {
  return pinyin(value.toLowerCase().replace(/e/gi, '伊'), { toneType: 'none', type: 'array' })
    .map(part => part.replace(/[^a-z0-9]/g, '')).filter(Boolean);
}

export function wakeWordScore(recognized: string, wakeWord: string): number {
  if (isBuiltInWakeWord(wakeWord)) return acceptsWakeTranscript(recognized, wakeWord) ? 1 : 0;
  const heard = syllables(recognized);
  const full = syllables(wakeWord);
  if (!full.length || !heard.length) return 0;
  const candidates = [full];
  const half = full.slice(0, full.length / 2);
  if (full.length % 2 === 0 && half.join(' ') === full.slice(full.length / 2).join(' ')) candidates.push(half);
  // Match the address at the beginning, allowing a trailing particle or request.
  // At least two complete syllables prevent a single common syllable waking us.
  return Math.max(...candidates.map(candidate => {
    if (candidate.length < 2 || heard.length < candidate.length) return 0;
    const matching = candidate.filter((part, index) => part === heard[index]).length;
    return matching < 2 ? 0 : matching / candidate.length;
  }));
}
