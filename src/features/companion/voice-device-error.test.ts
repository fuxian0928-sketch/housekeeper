import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceDeviceErrorMessage} from './voice-device-error';
test('device errors survive Electron wrapping and show repair guidance', () => {
  assert.match(voiceDeviceErrorMessage(Error("Error invoking remote method 'companion:list-native-devices': Error: VOICE_NATIVE_BUNDLE_INVALID")), /组件缺失或损坏/);
  assert.match(voiceDeviceErrorMessage(Error('VOICE_NATIVE_RUNTIME_CHECK_TIMEOUT')), /超时/);
  assert.match(voiceDeviceErrorMessage(Error('VOICE_DEVICE_SELECTION_UNAVAILABLE')), /重新选择/);
  assert.doesNotMatch(voiceDeviceErrorMessage(Error('SECRET-private-path')), /SECRET|private/);
});
