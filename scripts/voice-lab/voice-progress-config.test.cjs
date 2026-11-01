const test=require('node:test');
const assert=require('node:assert/strict');
const {readVoiceProgress,sanitizeVoiceProgress}=require('../../electron/voice-progress-config.cjs');
test('old settings get defaults, invalid renderer values do not enter saved config',()=>{
  assert.deepEqual(readVoiceProgress({}),{voiceProgressMode:'concise',voiceProgressFirstMs:2000,voiceProgressIntervalMs:8000});
  assert.deepEqual(sanitizeVoiceProgress({voiceProgressMode:'anything',voiceProgressFirstMs:'2000',voiceProgressIntervalMs:Infinity}),{});
  assert.deepEqual(sanitizeVoiceProgress({voiceProgressMode:'off',voiceProgressFirstMs:0,voiceProgressIntervalMs:50000}),{voiceProgressMode:'off',voiceProgressFirstMs:1000,voiceProgressIntervalMs:20000});
});
