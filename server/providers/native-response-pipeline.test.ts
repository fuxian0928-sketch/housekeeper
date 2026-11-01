import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeResponsePipeline } from './native-response-pipeline.js';

test('later completed text flushes within its coalescing budget with one in-flight Agent read',async()=>{
 const tail=gate(),audio=gate();let pulls=0;const spoken:string[]=[];
 const run=createNativeResponsePipeline({async *answer(){pulls++;yield '主人，我在。';pulls++;yield '第二句已经准备好了。';pulls++;await tail.promise;yield '末句。';},
 synthesize:()=>({ready:Promise.resolve(),append:text=>{spoken.push(text);audio.resolve();return true;},finish:()=>true,cancel(){},audio:{async *[Symbol.asyncIterator](){await audio.promise;yield Buffer.alloc(320)}}}),
 player:{async playStream(_key,source){for await(const _pcm of source){}}}});
 const task=run({key:{workerGeneration:1,audioGeneration:1,turn:1},text:'test',signal:new AbortController().signal,requestStandby:()=>true,beginPlayback:()=>true});
 await delay(160);assert.deepEqual(spoken,['主人，我在。','第二句已经准备好了。']);assert.equal(pulls,3);
 tail.resolve();await task;assert.equal(spoken.join(''),'主人，我在。第二句已经准备好了。末句。');
});

function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('waiting for first audio does not open the device playback watchdog',async()=>{
 const answer=gate(),pcm=gate();let opened=0,progress=0;
 const run=createNativeResponsePipeline({async *answer(){await answer.promise;yield '完整回答。';},
  synthesize:()=>({ready:Promise.resolve(),append:()=>{pcm.resolve();return true;},finish:()=>true,cancel(){},audio:{async *[Symbol.asyncIterator](){await pcm.promise;yield Buffer.alloc(320);}}}),
  player:{async playStream(_key,source){opened++;for await(const _pcm of source){}}}});
 const promise=run({key:{workerGeneration:1,audioGeneration:1,turn:1},text:'test',signal:new AbortController().signal,beginPlayback:()=>true,requestStandby:()=>true,progress:()=>{progress++;}});
 await delay(10);assert.equal(opened,0);answer.resolve();await promise;assert.equal(opened,1);assert.equal(progress,1);
});
function setup() {
  const controller = new AbortController(), audioReady = gate(), answerTail = gate(), receipt = gate();
  const stages:string[]=[];
  const spoken: string[] = []; let began = 0, cancelled = false, playing = false, ttsFinished = false;
  let turnSignal!: AbortSignal;
  const pipeline = createNativeResponsePipeline({
    onStage:stage=>{stages.push(stage);},
    async *answer(context) { turnSignal = context.signal; yield '明天是2026-09-20'; yield '。'; await answerTail.promise; yield '任务尚未创建。'; },
    synthesize(signal) { turnSignal = signal; return { ready: Promise.resolve(), append(text) { spoken.push(text); audioReady.resolve(); return true; }, finish() { ttsFinished = true; return true; }, cancel() { cancelled = true; },
      audio: { async *[Symbol.asyncIterator]() { await audioReady.promise; yield Buffer.alloc(320); } } }; },
    player: { async playStream(key, source, signal) { assert.deepEqual(key, { generation: 2, audioGeneration: 3, turn: 4 }); for await (const pcm of source) { signal.throwIfAborted(); assert.equal(pcm.length, 320); playing = true; } await receipt.promise; } }
  });
  const promise = pipeline({ key: { workerGeneration: 2, audioGeneration: 3, turn: 4 }, text: '测试', signal: controller.signal, requestStandby: () => true, beginPlayback() { began++; return !controller.signal.aborted; } });
  return { controller, answerTail, receipt, promise, spoken, stages, state: () => ({ began, cancelled, playing, ttsFinished, signal: turnSignal }) };
}
test('first complete sentence plays while Agent continues; completion waits for playback receipt', async () => {
  const f = setup(); let finished = false; void f.promise.then(() => { finished = true; });
  await delay(0);
  assert.deepEqual(f.spoken, ['明天是2026-09-20。']); assert.equal(f.state().playing, true); assert.equal(f.state().began, 1);
  assert.equal(f.state().ttsFinished, false); assert.equal(finished, false);
  f.answerTail.resolve(); await delay(0);
  assert.deepEqual(f.spoken, ['明天是2026-09-20。', '任务尚未创建。']); assert.equal(f.state().ttsFinished, true); assert.equal(finished, false);
  f.receipt.resolve(); await f.promise; assert.equal(f.state().cancelled, true);
  assert.deepEqual(f.stages,['tts-start','tts-ready','answer-start','first-answer-text','first-sentence','first-answer-pcm','playback-complete']);
});
test('new-turn abort settles even with stalled Agent and stops late text', async () => {
  const f = setup(); await delay(0); f.controller.abort();
  await assert.rejects(f.promise, /CANCELLED/); assert.equal(f.state().cancelled, true); assert.equal(f.state().signal.aborted, true);assert.equal(f.stages.at(-1),'response-cancelled');
  f.answerTail.resolve(); f.receipt.resolve(); await delay(0);
  assert.deepEqual(f.spoken, ['明天是2026-09-20。']); assert.equal(f.state().ttsFinished, false);
});
test('TTS startup failure never starts the Agent or playback', async () => {
  let touched = false, cancelled = false;
  const faultCodes: string[] = [];
  const run = createNativeResponsePipeline({
    onFailureCode: code => faultCodes.push(code),
    answer() { touched = true; throw Error('unexpected'); },
    synthesize() { return { ready: Promise.reject(Error('TTS_FAILED')), append: () => true, finish: () => true, cancel() { cancelled = true; }, audio: { async *[Symbol.asyncIterator]() {} } }; },
    player: { async playStream() { touched = true; } }
  });
  await assert.rejects(run({ key: { workerGeneration: 1, audioGeneration: 1, turn: 1 }, text: 'test', signal: new AbortController().signal, requestStandby: () => true, beginPlayback: () => true }), /TTS_FAILED/);
  assert.equal(touched, false); assert.equal(cancelled, true);
  assert.deepEqual(faultCodes, ['TTS_FAILED']);
});


test('life startup overlaps TTS handshake with one bounded answer chunk, without early audio', async () => {
  const ready=gate(), audioReady=gate();let pulls=0;const appended:string[]=[],stages:string[]=[];
  const run=createNativeResponsePipeline({overlapAnswerStartup:true,onStage:s=>stages.push(s),
    async *answer(){pulls++;yield '主人，我在。';pulls++;yield '请说。';},
    synthesize:()=>({ready:ready.promise,append:text=>{appended.push(text);audioReady.resolve();return true;},finish:()=>true,cancel(){},audio:{async *[Symbol.asyncIterator](){await audioReady.promise;yield Buffer.alloc(320);}}}),
    player:{async playStream(_key,source){for await(const _chunk of source){}}}
  });
  const pending=run({key:{workerGeneration:1,audioGeneration:1,turn:1},text:'hello',signal:new AbortController().signal,requestStandby:()=>true,beginPlayback:()=>true});
  await delay(0);assert.equal(pulls,1);assert.deepEqual(appended,[]);assert.ok(stages.includes('first-answer-text'));assert.ok(!stages.includes('tts-ready'));
  ready.resolve();await pending;assert.equal(pulls,2);assert.deepEqual(appended,['主人，我在。','请说。']);
});

test('life overlap abort discards buffered text before delayed TTS becomes ready',async()=>{
  const ready=gate();const controller=new AbortController();let appends=0,cancelled=false;
  const run=createNativeResponsePipeline({overlapAnswerStartup:true,async *answer(){yield '不能迟到播放。';},
    synthesize:()=>({ready:ready.promise,append:()=>{appends++;return true;},finish:()=>true,cancel(){cancelled=true},audio:{async *[Symbol.asyncIterator](){}}}),player:{async playStream(){throw Error('unexpected playback')}}});
  const pending=run({key:{workerGeneration:1,audioGeneration:1,turn:1},text:'test',signal:controller.signal,requestStandby:()=>true,beginPlayback:()=>true});
  await delay(0);controller.abort();await assert.rejects(pending,/CANCELLED/);ready.resolve();await delay(0);assert.equal(appends,0);assert.equal(cancelled,true);
});

test('early life answer failure cancels a stalled TTS handshake',async()=>{
  let cancelled=false;
  const run=createNativeResponsePipeline({overlapAnswerStartup:true,async *answer(){throw Error('ANSWER_FAILED')},
    synthesize:()=>({ready:new Promise(()=>{}),append:()=>true,finish:()=>true,cancel(){cancelled=true},audio:{async *[Symbol.asyncIterator](){}}}),player:{async playStream(){}}});
  await assert.rejects(run({key:{workerGeneration:1,audioGeneration:1,turn:1},text:'test',signal:new AbortController().signal,requestStandby:()=>true,beginPlayback:()=>true}),/ANSWER_FAILED/);
  assert.equal(cancelled,true);
});


test('simultaneous TTS rejection and synchronous life iterator failure are both observed',async()=>{
  let cancelled=false;
  const run=createNativeResponsePipeline({overlapAnswerStartup:true,answer(){throw Error('ITERATOR_FAILED')},
    synthesize:()=>({ready:Promise.reject(Error('TTS_FAILED')),append:()=>true,finish:()=>true,cancel(){cancelled=true},audio:{async *[Symbol.asyncIterator](){}}}),player:{async playStream(){}}});
  await assert.rejects(run({key:{workerGeneration:1,audioGeneration:1,turn:1},text:'test',signal:new AbortController().signal,requestStandby:()=>true,beginPlayback:()=>true}),/ITERATOR_FAILED/);
  await delay(0);assert.equal(cancelled,true);
});


test('processing interruption holds generated audio and cancellation prevents late playback',async()=>{
 const hold=gate(),controller=new AbortController();let heard=0,began=0;
 const run=createNativeResponsePipeline({beforeAudio:()=>hold.promise,async *answer(){yield '旧回答。'},
 synthesize:()=>({ready:Promise.resolve(),append:()=>true,finish:()=>true,cancel(){},audio:{async *[Symbol.asyncIterator](){yield Buffer.alloc(320)}}}),
 player:{async playStream(_key,source){for await(const _pcm of source){heard++}}}});
 const pending=run({key:{workerGeneration:1,audioGeneration:1,turn:1},text:'test',signal:controller.signal,requestStandby:()=>true,beginPlayback:()=>{began++;return true}});
 await delay(0);assert.equal(heard,0);assert.equal(began,0);controller.abort();await assert.rejects(pending,/CANCELLED/);hold.resolve();await delay(0);assert.equal(heard,0);assert.equal(began,0);
});


test('processing backchannel releases held audio once without regenerating the answer',async()=>{
 const hold=gate();let heard=0,answers=0;
 const run=createNativeResponsePipeline({beforeAudio:()=>hold.promise,async *answer(){answers++;yield '继续原回答。'},
 synthesize:()=>({ready:Promise.resolve(),append:()=>true,finish:()=>true,cancel(){},audio:{async *[Symbol.asyncIterator](){yield Buffer.alloc(320)}}}),
 player:{async playStream(_key,source){for await(const _pcm of source){heard++}}}});
 const pending=run({key:{workerGeneration:1,audioGeneration:1,turn:1},text:'test',signal:new AbortController().signal,requestStandby:()=>true,beginPlayback:()=>true});
 await delay(0);assert.equal(heard,0);hold.resolve();await pending;assert.equal(heard,1);assert.equal(answers,1);
});
