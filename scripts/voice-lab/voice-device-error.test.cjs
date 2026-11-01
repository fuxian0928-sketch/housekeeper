const test = require('node:test'), assert = require('node:assert/strict');
const {voiceDeviceError} = require('../../electron/voice-device-error.cjs');
test('device diagnostics preserve actionable codes without exposing paths or secrets', () => {
  for (const code of ['VOICE_NATIVE_BUNDLE_INVALID','VOICE_NATIVE_RUNTIME_CHECK_TIMEOUT','VOICE_DEVICE_SELECTION_UNAVAILABLE']) {
    assert.equal(voiceDeviceError(Error(code)).message, code);
  }
  for (const error of [null, Error('private path or credential'), Error('VOICE_UNKNOWN_PRIVATE_DETAIL')]) {
    assert.equal(voiceDeviceError(error).message, 'VOICE_NATIVE_RUNTIME_CHECK_FAILED');
  }
});
