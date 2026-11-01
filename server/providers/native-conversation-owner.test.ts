import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeConversationOwner, type ConversationDependencies } from './native-conversation-owner.js';
import { acceptsWakeTranscript } from '../domain/voice-wake-transcript.js';
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class Worker extends EventEmitter {
  commands: { generation: number; audioGeneration: number; turn: number; type: string }[] = [];
  async start() { this.emit('event', { type: 'ready', generation: 1 }); return { generation: 1 }; }
  async stop() { this.emit('closed', { generation: 1 }); }
  command(value: Worker['commands'][number]) { this.commands.push(value); return true; }
  event(type: string, turn: number, reason?: string) { this.emit('event', { type, generation: 1, audioGeneration: 1, turn, frameCount: 1, reason }); }
}
function setup(budget = 1000, acceptWakeTranscript?: (text: string) => boolean) {
  const worker = new Worker();
  const sessions: Array<ReturnType<typeof deferred<{ text: string; final: true; audioBytes: number }>> & { signal: AbortSignal }> = [];
  const responses: Array<{ context: Parameters<ConversationDependencies['respond']>[0]; done: ReturnType<typeof deferred<void>> }> = [];
  const statuses: string[] = [];
  let consume!: (packet: any) => boolean;
  const owner = createNativeConversationOwner(callback => { consume = callback; return worker; }, {
    turnBudgetMs: budget,
    acceptWakeTranscript,
    createSession(signal) {
      const session = { ...deferred<{ text: string; final: true; audioBytes: number }>(), signal }; sessions.push(session);
      return { result: session.promise, finish: () => session.promise, append: () => true, cancel() {} };
    },
    async respond(context) { const done = deferred<void>(); responses.push({ context, done }); await done.promise; },
    onStatus(event) { statuses.push(`${event.type}:${event.code ?? ''}`); }
  });
  const startTurn = (turn: number, reason?: string) => {
    worker.event('turn-start', turn, reason);
    assert.equal(consume({ workerGeneration: 1, audioGeneration: 1, turn, sequence: 0, pcm: Buffer.alloc(320), capturedAt: performance.now() }), true);
  };
  const recognize = async (turn: number, text = '测试') => {
    worker.event('turn-end', turn);
    sessions.at(-1)!.resolve({ text, final: true, audioBytes: 320 });
    await settle();
  };
  return { owner, worker, sessions, responses, statuses, startTurn, recognize };
}

test('an acoustic false wake stays silent and returns to standby after ASR rejects its transcript', async () => {
  const f = setup(1000, text => text.startsWith('小E')); await f.owner.start();
  try {
    f.startTurn(1, 'wake'); await f.recognize(1, '我正在打字');
    assert.equal(f.responses.length, 0);
    assert.equal(f.worker.commands.at(-1)?.type, 'dismiss');
    f.startTurn(2, 'wake'); await f.recognize(2, '小E，帮我看看');
    assert.equal(f.responses.length, 1);
  } finally { await f.owner.close(); }
});

test('the bundled ASR spelling of Xiwei stays awake and accepts the next ordinary turn', async () => {
  const f=setup(1000,text=>acceptsWakeTranscript(text,'小E'));await f.owner.start();
  try {
    f.startTurn(1,'wake');await f.recognize(1,'戚薇西威你好');
    assert.equal(f.responses.length,1);assert.equal(f.worker.commands.some(command=>command.type==='dismiss'),false);
    f.responses[0].done.resolve();await settle();
    assert.equal(f.worker.commands.at(-1)?.type,'answer-finished');
    f.startTurn(2,'speech');await f.recognize(2,'帮我看看今天的待办');
    assert.equal(f.responses.length,2);assert.equal(f.responses[1].context.text,'帮我看看今天的待办');
    f.responses[1].done.resolve();await settle();
    f.startTurn(3,'wake');await f.recognize(3,'细微差别有哪些');
    assert.equal(f.responses.length,2);assert.equal(f.worker.commands.at(-1)?.type,'dismiss');
  } finally {await f.owner.close();}
});

test('two turns resume listening only after each playback finishes', async () => {
  const f = setup(); await f.owner.start();
  try {
    for (const turn of [1, 2]) {
      f.startTurn(turn); await f.recognize(turn);
      const response = f.responses.at(-1)!;
      assert.equal(response.context.beginPlayback(), true);
      assert.equal(response.context.beginPlayback(), false);
      assert.equal(f.worker.commands.at(-1)!.type, 'speaking');
      response.done.resolve(); await delay(0);
      assert.deepEqual(f.worker.commands.at(-1), { generation: 1, audioGeneration: 1, turn, type: 'answer-finished' });
      assert.equal(response.context.signal.aborted, true);
    }
    assert.equal(f.statuses.filter(value => value === 'finished:').length, 2);
  } finally { await f.owner.close(); }
});

test('device progress keeps a 100-second reply alive across the former 30/60-second cutoffs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(300_000); await f.owner.start();
  try {
    f.startTurn(1); await f.recognize(1);
    const response = f.responses[0]; response.context.beginPlayback();
    for (let second=1; second<=100; second++) {
      t.mock.timers.tick(1000);
      f.worker.emit('event',{type:'playback-progress',generation:1,audioGeneration:1,turn:1,renderedFrames:second*100});
      assert.equal(response.context.signal.aborted,false,`unexpected cancellation at ${second}s`);
    }
    response.done.resolve(); await settle();
    assert.equal(f.worker.commands.at(-1)?.type,'answer-finished');
    assert.deepEqual(f.statuses,['responding:','speaking:','finished:']);
    t.mock.timers.tick(300_000);
    assert.equal(f.worker.commands.filter(c=>c.type==='answer-finished').length,1);
  } finally { await f.owner.close(); }
});

test('stalled response fails, and duplicate or stale playback receipts cannot keep it alive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(300_000); await f.owner.start();
  try {
    f.startTurn(1); await f.recognize(1);
    const response=f.responses[0];response.context.beginPlayback();
    const event={type:'playback-progress',generation:1,audioGeneration:1,turn:1,renderedFrames:100};
    f.worker.emit('event',event);
    t.mock.timers.tick(59_000);
    f.worker.emit('event',event); // Same device frame is not progress.
    f.worker.emit('event',{...event,turn:2,renderedFrames:200});
    f.worker.emit('event',{...event,generation:2,renderedFrames:200});
    t.mock.timers.tick(1001);
    assert.equal(response.context.signal.aborted,true);
    assert.equal(f.worker.commands.at(-1)?.type,'answer-failed');
    assert.equal(f.statuses.at(-1),'failed:VOICE_TURN_TIMEOUT');
  } finally { await f.owner.close(); }
});

test('response inactivity starts after recognition, real progress refreshes it, hard cap remains', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f=setup(300_000);await f.owner.start();
  try {
    f.startTurn(1);t.mock.timers.tick(25_000);await f.recognize(1);
    const response=f.responses[0];
    for (let i=0;i<5;i++) { t.mock.timers.tick(50_000);response.context.progress?.();assert.equal(response.context.signal.aborted,false); }
    t.mock.timers.tick(25_001);
    assert.equal(response.context.signal.aborted,true);
    assert.equal(f.statuses.at(-1),'failed:VOICE_TURN_TIMEOUT');
  } finally { await f.owner.close(); }
});

test('new input cancels old response and late playback/completion cannot affect new turn', async () => {
  const f = setup(); await f.owner.start();
  try {
    f.startTurn(1); await f.recognize(1);
    const old = f.responses[0];
    f.startTurn(2);
    assert.equal(old.context.signal.aborted, true);
    assert.equal(old.context.beginPlayback(), false);
    old.done.resolve(); await delay(0);
    assert.deepEqual(f.worker.commands, []);
    await f.recognize(2);
    assert.equal(f.responses[1].context.signal.aborted, false);
  } finally { await f.owner.close(); }
});

test('timeout during recognition cancels cloud session and drops its late final', async () => {
  const f = setup(20); await f.owner.start();
  try {
    f.startTurn(1); await delay(35);
    assert.equal(f.sessions[0].signal.aborted, true);
    await f.recognize(1);
    assert.equal(f.responses.length, 0);
    assert.deepEqual(f.statuses, ['failed:VOICE_TURN_TIMEOUT']);
    assert.equal(f.worker.commands.length, 1);
  } finally { await f.owner.close(); }
});

test('standby, worker fault and stop all abort playback without stale completion', async () => {
  for (const action of ['standby', 'fault', 'stop']) {
    const f = setup(); await f.owner.start();
    try {
      f.startTurn(1); await f.recognize(1);
      const response = f.responses[0]; response.context.beginPlayback();
      if (action === 'standby') f.worker.event('standby', 1);
      else if (action === 'fault') f.worker.emit('fault', { generation: 1 });
      else await f.owner.stop();
      assert.equal(response.context.signal.aborted, true);
      response.done.resolve(); await delay(0);
      assert.deepEqual(f.worker.commands.map(x => x.type), ['speaking']);
    } finally { await f.owner.close(); }
  }
});

test('dismissal waits for playback, then enters standby instead of listening', async () => {
  const f = setup(); await f.owner.start();
  try {
    f.startTurn(1); await f.recognize(1);
    const response = f.responses[0];
    assert.equal(response.context.requestStandby(), true);
    assert.equal(response.context.beginPlayback(), true);
    assert.deepEqual(f.worker.commands.map(c => c.type), ['dismiss-after-playback', 'speaking']);
    response.done.resolve(); await delay(0);
    assert.equal(f.worker.commands.at(-1)?.type, 'dismiss');
  } finally { await f.owner.close(); }
});

test('dismissal still ends session when response times out, but never dismisses a newer turn', async () => {
  const f = setup(80); await f.owner.start();
  try {
    f.startTurn(1); await f.recognize(1); f.responses[0].context.requestStandby();
    await delay(100); assert.equal(f.worker.commands.at(-1)?.type, 'dismiss');
    f.startTurn(2); await f.recognize(2); const old = f.responses[1]; old.context.requestStandby();
    f.startTurn(3); const before = f.worker.commands.length;
    assert.equal(old.context.requestStandby(), false); old.done.resolve(); await delay(0);
    assert.equal(f.worker.commands.length, before);
  } finally { await f.owner.close(); }
});

test('idle farewell skips recognition, runs once, and cannot finish after rewake', async () => {
  const f = setup(); await f.owner.start();
  try {
    f.worker.event('idle-farewell', 1); f.worker.event('idle-farewell', 1); await delay(0);
    assert.equal(f.sessions.length, 0); assert.equal(f.responses.length, 1);
    assert.equal(f.responses[0].context.control, 'idle-farewell');
    f.responses[0].done.resolve(); await delay(0);
    assert.equal(f.worker.commands.at(-1)?.type, 'dismiss');
    f.worker.event('idle-farewell', 2); await delay(0);
    const old = f.responses[1]; f.startTurn(3);
    assert.equal(old.context.signal.aborted, true);
    const before = f.worker.commands.length; old.done.resolve(); await delay(0);
    assert.equal(f.worker.commands.length, before);
  } finally { await f.owner.close(); }
});

test('response failures preserve sanitized stage through the conversation owner',async()=>{
 const worker=new Worker(),statuses:string[]=[];let consume!:(packet:any)=>boolean;
 const owner=createNativeConversationOwner(callback=>{consume=callback;return worker;},{
  createSession:()=>{const final=deferred<{text:string;final:true;audioBytes:number}>();return {append:()=>true,finish:()=>{final.resolve({text:'测试',final:true,audioBytes:320});return final.promise;},result:final.promise,cancel(){}};},
  respond:async()=>{throw Error('TTS_CONNECTION_FAILED');},onStatus:e=>{if(e.type==='failed')statuses.push(e.code!);}
 });
 await owner.start();try{
  worker.event('turn-start',1);consume({workerGeneration:1,audioGeneration:1,turn:1,sequence:0,pcm:Buffer.alloc(320),capturedAt:performance.now()});worker.event('turn-end',1);
  await delay(10);assert.deepEqual(statuses,['VOICE_SYNTHESIS_FAILED']);assert.equal(worker.commands.at(-1)?.type,'answer-failed');
 }finally{await owner.close();}
});


test('max-duration discards late recognition and responds with a control prompt, then resumes',async()=>{
 const f=setup();await f.owner.start();
 try{
  f.startTurn(1);
  f.worker.emit('event',{type:'turn-end',generation:1,audioGeneration:1,turn:1,frameCount:1,reason:'max-duration'});
  await delay(0);
  assert.equal(f.sessions[0].signal.aborted,true);
  assert.equal(f.responses.length,1);
  assert.equal(f.responses[0].context.control,'utterance-limit');
  assert.equal(f.responses[0].context.text,'');
  f.sessions[0].resolve({text:'新建未说完的任务',final:true,audioBytes:320});await delay(0);
  assert.equal(f.responses.length,1);
  f.responses[0].done.resolve();await delay(0);
  assert.equal(f.worker.commands.at(-1)?.type,'answer-finished');
  f.startTurn(2);await f.recognize(2);
  assert.equal(f.responses.length,2);assert.equal(f.responses[1].context.control,undefined);
  f.responses[1].done.resolve();await delay(0);
 }finally{await f.owner.close();}
});

test('ASR startup failure sends failure recovery and later utterance can complete',async()=>{
 const worker=new Worker();let attempts=0;const replies:string[]=[];let consume!:(packet:any)=>boolean;
 const owner=createNativeConversationOwner(callback=>{consume=callback;return worker;},{
  createSession(){if(++attempts===1)throw Error('provider unavailable');const final=deferred<{text:string;final:true;audioBytes:number}>();return {append:()=>true,result:final.promise,cancel(){},finish(){final.resolve({text:'下一轮',final:true,audioBytes:0});return final.promise;}};},
  async respond(context){replies.push(context.text);}
 });
 await owner.start();try{
  worker.event('turn-start',1);
  assert.equal(worker.commands.at(-1)?.type,'answer-failed');
  assert.equal(replies.length,0);
  // The next turn is independent; no stale first-turn result can resume it.
  worker.event('turn-start',2);assert.equal(consume({workerGeneration:1,audioGeneration:1,turn:2,sequence:0,pcm:Buffer.alloc(320),capturedAt:performance.now()}),true);worker.event('turn-end',2);await delay(0);
  assert.equal(worker.commands.at(-1)?.type,'answer-finished');assert.deepEqual(replies,['下一轮']);
 }finally{await owner.close();}
});
