const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { saveJsonAtomically } = require('./atomic-json-store.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readVoiceClientId(dataDirectory) {
  const file = path.join(dataDirectory, 'voice-client-id.json');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')).deviceId;
    if (typeof value === 'string' && UUID.test(value)) return value;
  } catch {}
  const deviceId = randomUUID();
  saveJsonAtomically(file, { deviceId });
  return deviceId;
}

module.exports = { readVoiceClientId };
