const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readVoiceClientId } = require('../../electron/voice-client-id.cjs');

test('voice client identity survives restart and differs between devices', t => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-client-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-client-b-'));
  t.after(() => { fs.rmSync(first, {recursive:true,force:true}); fs.rmSync(second, {recursive:true,force:true}); });
  const id = readVoiceClientId(first);
  assert.match(id, /^[0-9a-f-]{36}$/i);
  assert.equal(readVoiceClientId(first), id);
  assert.notEqual(readVoiceClientId(second), id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(first, 'voice-client-id.json'), 'utf8')).deviceId, id);
});
