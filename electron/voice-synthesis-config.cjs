const DEFAULT_VOICE_SYNTHESIS = Object.freeze({ voiceSpeechRate: 1 });
function sanitizeVoiceSynthesis(changes) {
  if (!Number.isFinite(changes?.voiceSpeechRate)) return {};
  return { voiceSpeechRate: Math.round(Math.min(2, Math.max(0.5, changes.voiceSpeechRate)) * 100) / 100 };
}
function readVoiceSynthesis(config) { return { ...DEFAULT_VOICE_SYNTHESIS, ...sanitizeVoiceSynthesis(config) }; }
module.exports = { DEFAULT_VOICE_SYNTHESIS, sanitizeVoiceSynthesis, readVoiceSynthesis };
