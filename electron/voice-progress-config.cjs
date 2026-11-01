const DEFAULT_VOICE_PROGRESS = Object.freeze({ voiceProgressMode: 'concise', voiceProgressFirstMs: 2000, voiceProgressIntervalMs: 8000 });
function sanitizeVoiceProgress(input) {
  const result = {};
  if (['off','concise','detailed'].includes(input?.voiceProgressMode)) result.voiceProgressMode = input.voiceProgressMode;
  for (const [name,min,max] of [['voiceProgressFirstMs',1000,5000],['voiceProgressIntervalMs',5000,20000]]) {
    if (Number.isFinite(input?.[name])) result[name] = Math.min(max,Math.max(min,Math.round(input[name])));
  }
  return result;
}
function readVoiceProgress(config) { return {...DEFAULT_VOICE_PROGRESS,...sanitizeVoiceProgress(config)}; }
module.exports = { DEFAULT_VOICE_PROGRESS, sanitizeVoiceProgress, readVoiceProgress };
