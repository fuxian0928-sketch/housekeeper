import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireMicrophone } from './voice-device';

test('stale device ID falls back to default microphone', async () => {
  const calls: MediaStreamConstraints[] = [];
  const stream = {} as MediaStream;
  const devices = { getUserMedia: async (constraints: MediaStreamConstraints) => {
    calls.push(constraints);
    if (calls.length === 1) throw new DOMException('missing device', 'OverconstrainedError');
    return stream;
  } };
  assert.equal(await acquireMicrophone(devices, 'disconnected'), stream);
  assert.equal(calls.length, 2);
  assert.equal('deviceId' in (calls[1].audio as MediaTrackConstraints), false);
});

test('permission denial is not bypassed with another device', async () => {
  let calls = 0;
  await assert.rejects(acquireMicrophone({ getUserMedia: async () => {
    calls++; throw new DOMException('denied', 'NotAllowedError');
  } }, 'device'), { name: 'NotAllowedError' });
  assert.equal(calls, 1);
});
