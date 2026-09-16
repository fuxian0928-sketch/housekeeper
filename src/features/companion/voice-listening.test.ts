import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeechGate, listenForTranscript, NoSpeechError } from './voice-listening';

test('a click before a delayed answer does not close the recording', () => {
  const gate = createSpeechGate(0);
  for (let time = 0; time < 4000; time += 40) {
    assert.equal(gate(time === 200 ? .1 : 0, time).stop, false);
  }
  for (let time = 4000; time <= 4400; time += 40) gate(.07, time);
  assert.equal(gate(0, 5200).stop, false);
  assert.deepEqual(gate(0, 5600), { heardVoice: true, stop: true });
});

test('silence has a bounded wait and is not treated as speech', () => {
  assert.deepEqual(createSpeechGate(0)(0, 12000), { heardVoice: false, stop: true });
});

test('empty ASR result retries fresh recording, then uses the second utterance', async () => {
  let captures = 0, retries = 0;
  const text = await listenForTranscript(async () => String(++captures), async audio => audio === '1' ? '' : '明天提醒我开会', () => retries++, new AbortController().signal);
  assert.equal(text, '明天提醒我开会');
  assert.equal(captures, 2); assert.equal(retries, 1);
});

test('no microphone speech is retried once and exits; service failures are not retried', async () => {
  let captures = 0;
  await assert.rejects(listenForTranscript(async () => { captures++; throw new NoSpeechError(); }, async () => '', () => {}, new AbortController().signal), NoSpeechError);
  assert.equal(captures, 2);
  await assert.rejects(listenForTranscript(async () => 'audio', async () => { throw new Error('service unavailable'); }, () => assert.fail('must not retry service failures'), new AbortController().signal), /service unavailable/);
});

test('cancelled capture cannot trigger another recording or transcription', async () => {
  const controller = new AbortController();
  await assert.rejects(listenForTranscript(async () => { controller.abort(); return 'audio'; }, async () => { assert.fail('must not send cancelled audio'); }, () => assert.fail('must not retry after cancellation'), controller.signal), { name: 'AbortError' });
});
