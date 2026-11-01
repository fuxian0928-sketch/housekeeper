const DEFAULT_VOICE_TIMING = Object.freeze({ voiceContinuousEnabled: true, voiceMinSpeechMs: 120, voiceMaxUtteranceSeconds: 30, voiceIdleSeconds: 300, voiceEndSilenceMs: 1000, voiceBargeInEnabled: true });
function sanitizeVoiceTiming(changes) {
  const result = {};
  for (const [key, min, max] of [['voiceMinSpeechMs', 50, 500], ['voiceMaxUtteranceSeconds', 5, 30], ['voiceIdleSeconds', 30, 1800], ['voiceEndSilenceMs', 300, 3000]]) {
    if (Number.isFinite(changes?.[key])) result[key] = Math.min(max, Math.max(min, Math.round(changes[key])));
  }
  if (typeof changes?.voiceContinuousEnabled === 'boolean') result.voiceContinuousEnabled = changes.voiceContinuousEnabled;
  if (typeof changes?.voiceBargeInEnabled === 'boolean') result.voiceBargeInEnabled = changes.voiceBargeInEnabled;
  return result;
}
function readVoiceTiming(config) { return { ...DEFAULT_VOICE_TIMING, ...sanitizeVoiceTiming(config) }; }
module.exports = { DEFAULT_VOICE_TIMING, sanitizeVoiceTiming, readVoiceTiming };
