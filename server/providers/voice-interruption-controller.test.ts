import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterruptionController, classifyInterruption } from './voice-interruption-controller.js';

const key = { workerGeneration: 1, audioGeneration: 1, turn: 1, pauseId: 1 };
function fixture(options: { pause?: boolean; confirm?: boolean; failFinish?: boolean } = {}) {
  let clock = 1000, partial!: (text: string) => void;
  let resolve!: (result: { text: string; final: true; audioBytes: number }) => void;
  let reject!: (error: Error) => void;
  const calls: string[] = [];
  const result = new Promise<{ text: string; final: true; audioBytes: number }>((a, b) => { resolve = a; reject = b; });
  void result.catch(() => {});
  const controller = createInterruptionController({
    now: () => clock, budgetMs: 100,
    pause: () => { calls.push('pause'); return options.pause !== false; },
    resume: () => { calls.push('resume'); return true; },
    confirm: (_, decision) => { calls.push(decision); return options.confirm !== false; },
    createSession: (signal, callback) => {
      partial = callback;
      signal.addEventListener('abort', () => calls.push('abort'));
      return { result, append: () => true, finish: async () => { if (options.failFinish) throw Error('fail'); return result; }, cancel: () => { calls.push('cancel'); } };
    }
  });
  return { controller, calls, partial: (text: string) => partial(text), advance: (ms: number) => { clock += ms; },
    final: (text: string) => resolve({ text, final: true, audioBytes: 320 }), reject,
    finish: () => { assert.equal(controller.append(key, 0, Buffer.alloc(320), 1000), true); assert.equal(controller.finish(key, 1), true); } };
}

test('backchannels and negated stops do not cancel the answer', () => {
  for (const text of ['嗯', '好的', '不要停', '别停止', '你继续', '没事，你继续说', '没关系你继续说', '请你继续说下去', '接着说吧', '']) assert.equal(classifyInterruption(text), 'resume');
  for (const text of ['停一下', '请先暂停', '别说了']) assert.equal(classifyInterruption(text), 'stop');
  assert.equal(classifyInterruption('帮我新建任务'), 'interrupt');
  assert.equal(classifyInterruption('继续说之前先帮我改一下任务'), 'interrupt');
});

test('partial resume request waits for final and resumes existing audio without a new turn', async () => {
  const f=fixture();f.controller.begin(key);
  f.partial('没事');f.advance(90);f.partial('没事你继');f.advance(90);f.partial('没事你继续说');
  assert.equal(f.calls.includes('interrupt'),false);
  f.finish();f.final('没事你继续说');await sleep(0);
  assert.equal(f.calls.filter(c=>c==='resume').length,1);
  assert.equal(f.calls.includes('interrupt'),false);f.controller.close();
});
test('acknowledgement resumes, final command confirms exactly once', async () => {
  for (const [text, expected] of [['嗯', 'resume'], ['停一下', 'stop'], ['明天再安排', 'interrupt']]) {
    const f = fixture(); assert.equal(f.controller.begin(key), true); f.finish(); f.final(text); await sleep(0);
    assert.equal(f.calls.filter(v => v === expected).length, 1);
    assert.equal(f.controller.begin(key), false); f.controller.close();
  }
});
test('provisional text needs a stable prefix and 80ms before handoff', () => {
  const f = fixture(); f.controller.begin(key); f.partial('重新'); f.advance(79); f.partial('重新安排');
  assert.equal(f.calls.includes('interrupt'), false);
  f.advance(80); f.partial('重新安排一下'); assert.equal(f.calls.includes('interrupt'), true); f.controller.close();
});
test('deadline resumes and discards late cloud result', async () => {
  const f = fixture(); f.controller.begin(key); f.finish(); await sleep(130);
  f.final('新建任务'); await sleep(0);
  assert.equal(f.calls.filter(v => v === 'resume').length, 1); assert.equal(f.calls.includes('interrupt'), false); f.controller.close();
});
test('failed handoff resumes instead of leaving playback paused', async () => {
  const f = fixture({ confirm: false }); f.controller.begin(key); f.finish(); f.final('改成明天'); await sleep(0);
  assert.equal(f.calls.includes('resume'), true); f.controller.close();
});
test('retiring a turn never resumes it or accepts late callbacks', async () => {
  const f = fixture(); f.controller.begin(key); f.controller.retire(key); f.partial('新建任务'); f.final('新建任务'); await sleep(0);
  assert.equal(f.calls.includes('resume'), false); assert.equal(f.calls.includes('interrupt'), false); f.controller.close();
});
test('rejected pause never starts recognition', () => {
  const f = fixture({ pause: false }); assert.equal(f.controller.begin(key), false); assert.deepEqual(f.calls, ['pause']); f.controller.close();
});
test('invalid frame sequence, expired audio and oversized transcript resume safely', () => {
  for (const kind of ['sequence', 'expired', 'text']) {
    const f = fixture(); f.controller.begin(key);
    if (kind === 'text') f.partial('x'.repeat(4097));
    else { if (kind === 'expired') f.advance(2000); assert.equal(f.controller.append(key, kind === 'sequence' ? 1 : 0, Buffer.alloc(320), 1000), false); }
    assert.equal(f.calls.includes('resume'), true); f.controller.close();
  }
});
test('recognition and asynchronous finish failure promptly resume', async () => {
  for (const failFinish of [true, false]) {
    const f = fixture({ failFinish }); f.controller.begin(key); f.finish();
    if (!failFinish) f.reject(Error('network'));
    await sleep(0); assert.equal(f.calls.includes('resume'), true); f.controller.close();
  }
});
