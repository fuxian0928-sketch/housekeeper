import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceTrace, summarizeVoiceTrace, type VoiceTraceRecord } from './voice-trace';

test('answer latency includes recognition and excludes progress as answer onset', () => {
  let now = 0; const rows: VoiceTraceRecord[] = [];
  const t = createVoiceTrace('session', r => rows.push(r), () => now);
  t.mark('listen-start'); now = 1000; t.mark('speech-end');
  now = 2000; t.mark('asr-final'); now = 3000; t.mark('progress-playing');
  assert.equal(summarizeVoiceTrace(rows)?.answerOnsetMs, null);
  now = 5000; t.mark('answer-playing'); now = 6000; t.mark('completed');
  assert.equal(summarizeVoiceTrace(rows)?.answerOnsetMs, 4000);
  assert.equal(summarizeVoiceTrace(rows)?.playbackEvidence, 'renderer-playing');
});
test('late callbacks after cancellation cannot turn a failed turn into success', () => {
  const rows: VoiceTraceRecord[] = []; const t = createVoiceTrace('session', r => rows.push(r));
  t.mark('cancelled'); t.mark('answer-playing'); t.mark('completed');
  assert.equal(rows.length, 1); assert.equal(summarizeVoiceTrace(rows)?.outcome, 'cancelled');
  assert.equal(summarizeVoiceTrace(rows)?.answerOnsetMs, null);
});
test('diagnostic sink failure never changes execution and mixed turns are rejected', () => {
  assert.doesNotThrow(() => createVoiceTrace('s', () => { throw Error(); }).mark('failed'));
  const rows: VoiceTraceRecord[] = [];
  createVoiceTrace('s', r => rows.push(r)).mark('listen-start');
  createVoiceTrace('s', r => rows.push(r)).mark('completed');
  assert.throws(() => summarizeVoiceTrace(rows), /Mixed/);
});
test('silent retry uses latest speech boundary and fallback onset stays unmeasured', () => {
  let now = 0; const rows: VoiceTraceRecord[] = [];
  const t = createVoiceTrace('s', r => rows.push(r), () => now);
  t.mark('speech-end'); now = 4000; t.mark('speech-end');
  now = 5000; t.mark('asr-final'); t.mark('fallback-start'); t.mark('completed');
  assert.equal(summarizeVoiceTrace(rows)?.answerOnsetMs, null);
});
