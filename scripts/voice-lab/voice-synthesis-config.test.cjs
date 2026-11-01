const test = require('node:test');
const assert = require('node:assert/strict');
const { readVoiceSynthesis, sanitizeVoiceSynthesis } = require('../../electron/voice-synthesis-config.cjs');
test('native rate has an independent default and bounded numeric persistence', () => {
  assert.deepEqual(readVoiceSynthesis({speechRate:-3}), {voiceSpeechRate:1});
  assert.deepEqual(readVoiceSynthesis({voiceSpeechRate:1.25}), {voiceSpeechRate:1.25});
  assert.deepEqual(sanitizeVoiceSynthesis({voiceSpeechRate:5}), {voiceSpeechRate:2});
  assert.deepEqual(sanitizeVoiceSynthesis({voiceSpeechRate:-5}), {voiceSpeechRate:0.5});
  for (const value of ['1.25',null,NaN,Infinity]) assert.deepEqual(sanitizeVoiceSynthesis({voiceSpeechRate:value}), {});
});
