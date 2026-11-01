const DEFAULT_VOICE_PREFETCH = Object.freeze({ voicePrefetchEnabled: false, voicePrefetchAttempts: 2 });
function sanitizeVoicePrefetch(input) {
  const result = {};
  if (typeof input?.voicePrefetchEnabled === 'boolean') result.voicePrefetchEnabled = input.voicePrefetchEnabled;
  if ([1, 2].includes(input?.voicePrefetchAttempts)) result.voicePrefetchAttempts = input.voicePrefetchAttempts;
  return result;
}
function readVoicePrefetch(config) { return { ...DEFAULT_VOICE_PREFETCH, ...sanitizeVoicePrefetch(config) }; }
module.exports = { DEFAULT_VOICE_PREFETCH, sanitizeVoicePrefetch, readVoicePrefetch };
