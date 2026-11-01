import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceAsrTurnBridge, type AudioTurn } from './voice-asr-turn-bridge.js';

const key: AudioTurn = { workerGeneration: 1, audioGeneration: 1, turn: 1 };
function setup() {
  const events: any[] = [];
  const sessions: any[] = [];
  const bridge = new VoiceAsrTurnBridge({ onEvent: e => events.push(e), createSession: (signal, partial) => {
    let resolve!: (result: { text: string; final: true; audioBytes: number }) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<{ text: string; final: true; audioBytes: number }>((a, b) => { resolve = a; reject = b; });
    const session = { signal, partial, result, resolve, reject, cancelled: false, appended: 0, finished: 0,
      append() { this.appended++; return true; },
      finish() { this.finished++; return result; },
      cancel() { this.cancelled = true; } };
    sessions.push(session); return session;
  } });
  return { bridge, events, sessions };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('final waits for end of the same turn; previews remain distinct', async () => {
  const { bridge, events, sessions } = setup();
  assert.equal(bridge.start(key), true);
  assert.equal(bridge.append(key, 0, Buffer.alloc(320), 100), true);
  sessions[0].partial({ text: '预览', final: false });
  assert.equal(events[0].type, 'partial');
  assert.equal(bridge.finish(key, 1), true);
  sessions[0].resolve({ text: '最终', final: true, audioBytes: 320 }); await settle();
  assert.deepEqual(events.map(e => e.type), ['partial', 'final']);
  assert.equal(bridge.start(key), false);
  bridge.close();
});

test('new turn aborts old session and ignores its late preview/final/failure', async () => {
  const { bridge, events, sessions } = setup();
  bridge.start(key);
  const next = { ...key, turn: 2 }; bridge.start(next);
  assert.equal(sessions[0].signal.aborted, true);
  assert.equal(sessions[0].cancelled, true);
  sessions[0].partial({ text: '旧内容', final: false });
  sessions[0].resolve({ text: '旧结果', final: true, audioBytes: 320 }); await settle();
  assert.equal(bridge.append(key, 0, Buffer.alloc(320), 10), false);
  assert.equal(events.length, 0);
  bridge.close();
});

test('frame gaps, repeated timestamp and truncated end fail entire utterance', () => {
  for (const issue of ['gap', 'clock', 'end']) {
    const { bridge, events, sessions } = setup(); bridge.start(key);
    bridge.append(key, 0, Buffer.alloc(320), 10);
    if (issue === 'gap') bridge.append(key, 2, Buffer.alloc(320), 20);
    if (issue === 'clock') bridge.append(key, 1, Buffer.alloc(320), 10);
    if (issue === 'end') bridge.finish(key, 2);
    assert.equal(events[0].code, 'ASR_AUDIO_DISCONTINUITY');
    assert.equal(sessions[0].signal.aborted, true);
    assert.equal(bridge.finish(key, 1), false); bridge.close();
  }
});

test('worker retirement rejects all late starts and allows a new process', () => {
  const { bridge, sessions } = setup(); bridge.start(key);
  bridge.stopWorker(1);
  assert.equal(sessions[0].cancelled, true);
  assert.equal(bridge.start({ ...key, audioGeneration: 2, turn: 5 }), false);
  assert.equal(bridge.start({ ...key, workerGeneration: 2 }), true);
  bridge.stopWorker(1);
  assert.equal(sessions[1].cancelled, false);
  bridge.close(); assert.equal(bridge.start({ ...key, workerGeneration: 3 }), false);
});

test('premature final is rejected; arbitrary errors never leak to UI', async () => {
  const first = setup(); first.bridge.start(key);
  first.sessions[0].resolve({ text: '未结束', final: true, audioBytes: 320 }); await settle();
  assert.equal(first.events[0].code, 'ASR_PREMATURE_RESULT'); first.bridge.close();
  const second = setup(); second.bridge.start(key);
  second.sessions[0].reject(new Error('secret request transcript')); await settle();
  assert.equal(second.events[0].code, 'ASR_FAILED'); second.bridge.close();
});

test('provider setup failure terminates turn without leaving a reusable identity', () => {
  const events: any[] = [];
  const bridge = new VoiceAsrTurnBridge({ onEvent: e => events.push(e), createSession: () => { throw new Error('private settings'); } });
  assert.equal(bridge.start(key), false);
  assert.equal(events[0].code, 'ASR_START_FAILED');
  assert.equal(bridge.start(key), false); bridge.close();
});
