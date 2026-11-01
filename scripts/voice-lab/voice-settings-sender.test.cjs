const test = require('node:test');
const assert = require('node:assert/strict');
const { isVoiceSettingsSender, voiceSettingsSenderFailure } = require('../../electron/voice-settings-sender.cjs');

test('accepts the same trusted top frame even when Electron returns different wrappers', () => {
  const mainFrame = { frameTreeNodeId: 42 };
  const webContents = { id: 7, mainFrame };
  const window = { webContents };
  const event = { sender: webContents, senderFrame: { frameTreeNodeId: 42, parent: null, detached: false, url: 'http://127.0.0.1:43110/settings' } };
  assert.equal(isVoiceSettingsSender(event, window, 43110), true);
  assert.equal(isVoiceSettingsSender({ ...event, senderFrame: { ...event.senderFrame, parent: {} } }, window, 43110), false);
  assert.equal(isVoiceSettingsSender({ ...event, senderFrame: { ...event.senderFrame, frameTreeNodeId: 43 } }, window, 43110), true);
  assert.equal(isVoiceSettingsSender({ ...event, senderFrame: { ...event.senderFrame, frameTreeNodeId: undefined } }, window, 43110), true);
  assert.equal(isVoiceSettingsSender({ ...event, senderFrame: { ...event.senderFrame, url: 'https://example.com/' } }, window, 43110), false);
  assert.equal(isVoiceSettingsSender({ ...event, sender: { id: 8, mainFrame } }, window, 43110), true);
  assert.equal(isVoiceSettingsSender({ ...event, sender: { id: 8 }, senderFrame: { ...event.senderFrame, frameTreeNodeId: 43 } }, window, 43110), false);
  assert.equal(isVoiceSettingsSender({ ...event, sender: { id: 7, mainFrame } }, window, 43110), true);
  assert.equal(voiceSettingsSenderFailure({ ...event, senderFrame: { ...event.senderFrame, parent: {} } }, window, 43110), 'subframe');
  assert.equal(voiceSettingsSenderFailure({ ...event, sender: { id: 8 }, senderFrame: { ...event.senderFrame, frameTreeNodeId: 43 } }, window, 43110), 'window-id');
});
