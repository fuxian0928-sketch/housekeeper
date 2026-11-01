import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { IDLE_FAREWELL } from '../domain/voice-session-commands.js';
import { createNativeVoiceRuntime, type NativeVoiceSettings } from './native-voice-runtime.js';
const settings: NativeVoiceSettings = { speechServiceBaseUrl: 'https://dashscope.aliyuncs.com/api/v1', speechRealtimeRecognitionModel: 'qwen3-asr-flash-realtime', synthesisBaseUrl: 'https://dashscope.aliyuncs.com/api/v1', synthesisModel: 'qwen3-tts-flash-realtime', voice: 'Cherry', routingMode: 'work', projectId: 'p1' };
class Worker extends EventEmitter {
  starts = 0; commands: any[] = [];
  async start() { this.starts++; this.emit('event', { type: 'ready', generation: 1 }); return { generation: 1 }; }
  async stop() { this.emit('closed', { generation: 1 }); }
  command(value: any) { this.commands.push(value); return true; }
  event(type: string, turn: number) { this.emit('event', { type, generation: 1, audioGeneration: 1, turn, frameCount: 1 }); }
}

test('local speech starts with no credentials and rejects missing local providers before capture',async()=>{
  const local:NativeVoiceSettings={...settings,speechExecution:'local',speechServiceBaseUrl:'local://asr',speechRealtimeRecognitionModel:'zipformer-local',synthesisBaseUrl:'local://tts',synthesisModel:'moss-local',voice:'xiwei-sweet-soft'};
  let keyReads=0;
  const make=(installed:boolean)=>{
    const worker=new Worker();
    const runtime=createNativeVoiceRuntime({settings:()=>local,key:()=>{keyReads++;throw Error('must not read a cloud key');},chatBaseUrl:'http://127.0.0.1:1',conversation:{read:()=>null,save(){},clear:()=>null},createWorker:()=>worker,createPlayer:()=>({async playStream(){}}),...(installed?{connectAsr:(()=>{}) as any,connectTts:(()=>{}) as any}:{})});
    return {runtime,worker};
  };
  const missing=make(false);await assert.rejects(missing.runtime.start(),/VOICE_LOCAL_PROVIDER_MISSING/);assert.equal(missing.worker.starts,0);await missing.runtime.close();
  const valid=make(true);try{await valid.runtime.start();assert.equal(valid.worker.starts,1);assert.equal(keyReads,0);}finally{await valid.runtime.close();}
});
test('explicit local computer connection is spoken and handled without calling the Agent',async()=>{
  const worker=new Worker(),spoken:string[]=[],actions:string[]=[],statuses:string[]=[];let consume:any,finalize:any;
  const runtime=createNativeVoiceRuntime({settings:()=>({...settings,voicePrefetchEnabled:false}),key:()=> 'fixture',chatBaseUrl:'http://127.0.0.1:1',conversation:{read:()=>null,save(){},clear:()=>null},onComputerControl:async action=>{actions.push(action);},createWorker:callback=>{consume=callback;return worker;},createPlayer:()=>({async playStream(_key,audio){for await(const _ of audio){}}}),connectAsr:(()=>{const result=new Promise(resolve=>{finalize=resolve;});return {ready:Promise.resolve(),result,append:()=>true,finish:()=>result,cancel(){}};}) as any,connectTts:(()=>{let complete!:()=>void;const done=new Promise<void>(resolve=>{complete=resolve;});return {ready:Promise.resolve(),append(text:string){spoken.push(text);return true;},finish(){complete();return true;},cancel(){complete();},audio:{async *[Symbol.asyncIterator](){await done;yield Buffer.alloc(320);}}};}) as any,onStatus:event=>statuses.push(event.type)});
  try{await runtime.start();worker.event('turn-start',1);consume({workerGeneration:1,audioGeneration:1,turn:1,sequence:0,pcm:Buffer.alloc(320),capturedAt:performance.now()});worker.event('turn-end',1);finalize({text:'希微，请连接本机。',final:true,audioBytes:320});for(let index=0;index<100&&!statuses.includes('finished');index++)await delay(10);assert.deepEqual(actions,['connect']);assert.ok(spoken.join('').includes('本机控制已连接'));assert.ok(statuses.includes('finished'));}
  finally{await runtime.close();}
});

test('interruption keeps the current turn model while the next turn uses saved changes', async () => {
  const worker = new Worker();
  let config = { ...settings };
  const models: string[] = [];
  const runtime = createNativeVoiceRuntime({ settings: () => config, key: () => 'fixture',
    chatBaseUrl: 'http://127.0.0.1:1', conversation: { read: () => null, save() {}, clear: () => null },
    createWorker: () => worker,
    createPlayer: () => ({ async playStream() {}, pause: () => true, resume: () => true }),
    connectAsr: ((options: any) => {
      models.push(options.model);
      const result = new Promise(() => {});
      return { ready: Promise.resolve(), result, append: () => true, finish: () => result, cancel() {} };
    }) as any
  });
  try {
    await runtime.start(); worker.event('turn-start', 1);
    config = { ...config, speechRealtimeRecognitionModel: 'qwen3-asr-flash-realtime-2026-02-10' };
    runtime.configure();
    worker.emit('event', { type: 'interruption-start', generation: 1, audioGeneration: 1, turn: 1, pauseId: 1 });
    assert.deepEqual(models, [settings.speechRealtimeRecognitionModel, settings.speechRealtimeRecognitionModel]);
    worker.event('turn-cancelled', 1); worker.event('turn-start', 2);
    assert.equal(models.at(-1), config.speechRealtimeRecognitionModel);
    worker.emit('event', { type: 'interruption-start', generation: 1, audioGeneration: 1, turn: 2, pauseId: 2 });
    assert.equal(models.at(-1), config.speechRealtimeRecognitionModel);
    assert.equal(models.length, 4);
  } finally { await runtime.close(); }
});
test('runtime refuses missing credentials before opening microphone', async () => {
  const worker = new Worker();
  const runtime = createNativeVoiceRuntime({ settings: () => settings, key: () => null, chatBaseUrl: 'http://localhost', conversation: { read: () => null, save() {}, clear: () => null }, createWorker: () => worker, createPlayer: () => ({ async playStream() {} }) });
  await assert.rejects(runtime.start(), /KEY_NOT_CONFIGURED/); assert.equal(worker.starts, 0); await runtime.close();
});
test('runtime shares work chat but handles direct dismissal without an Agent request', { timeout: 5000 }, async () => {
  const prefetchRequests: any[] = [];
  const token = '11111111-1111-4111-8111-111111111111';
  const requests: any[] = [], spoken: string[] = [], statuses: string[] = [], rates: number[] = [], asrKeys: string[] = [], ttsKeys: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; if (request.url === '/api/voice/memory-prefetch') { prefetchRequests.push(JSON.parse(body)); response.end(JSON.stringify({token})); return; }
    requests.push(JSON.parse(body));
    response.end(JSON.stringify({ type: 'delta', delta: '收到。' }) + '\n' + JSON.stringify({ type: 'done', answer: '收到。', conversationId: 'voice-id' }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const worker = new Worker(); let consume: any, finalize: any, partial: any, config = { ...settings, voicePrefetchEnabled:true, voiceFarewellText:"好的，下次叫我。" }, history: string | null = null, failTts = false, credential = 'fixture-first';
  const runtime = createNativeVoiceRuntime({ settings: () => config, key: () => credential, chatBaseUrl: `http://127.0.0.1:${address.port}`,
    conversation: { read: () => history, save: id => { history = id; }, clear: () => { const old = history; history = null; return old; } }, createWorker: callback => { consume = callback; return worker; },
    createPlayer: () => ({ async playStream(_key, audio, signal) { for await (const pcm of audio) { signal.throwIfAborted(); assert.equal(pcm.length, 320); } } }),
    connectAsr: ((options: any) => { asrKeys.push(options.apiKey); partial = options.onPartial; const result = new Promise<any>(resolve => { finalize = resolve; }); return { ready: Promise.resolve(), result, append: () => true, finish: () => result, cancel() {} }; }) as any,
    connectTts: ((options: any) => { ttsKeys.push(options.apiKey); rates.push(options.speechRate); if (failTts) throw Error('TTS_UNAVAILABLE'); let ready!: () => void; const gate = new Promise<void>(resolve => { ready = resolve; }); return { ready: Promise.resolve(), append(text: string) { spoken.push(text); return true; }, finish() { ready(); return true; }, cancel() { ready(); }, audio: { async *[Symbol.asyncIterator]() { await gate; yield Buffer.alloc(320); } } }; }) as any,
    onStatus: event => { statuses.push(event.type); }
  });
  try {
    await runtime.start();
    for (const turn of [1, 2, 3, 4]) {
      worker.event('turn-start', turn);
      consume({ workerGeneration: 1, audioGeneration: 1, turn, sequence: 0, pcm: Buffer.alloc(320), capturedAt: performance.now() });
      // A change after recognition starts applies to the next turn only.
      config = { ...config, routingMode: 'life', voiceSpeechRate:1.25 };
      if (turn === 1) credential = 'fixture-next';
      if (turn === 1) { partial({text:'查看当前项目资料'}); await delay(450); assert.equal(prefetchRequests.length,1); }
      worker.event('turn-end', turn); finalize({ text: ['查看当前项目资料', '测试', '不要离开', '好的好的，你退下吧。'][turn-1], final: true, audioBytes: 320 });
      for (let i = 0; i < 100 && statuses.filter(s => s === 'finished').length < turn; i++) await delay(10);
      assert.equal(statuses.filter(s => s === 'finished').length, turn);
    }
    assert.deepEqual(rates.slice(0,4),[1,1.25,1.25,1.25]);
    assert.equal(asrKeys[0], 'fixture-first');assert.equal(ttsKeys[0], 'fixture-first');
    assert.equal(asrKeys[1], 'fixture-next');assert.equal(ttsKeys[1], 'fixture-next');
    assert.equal(requests[0].voicePrefetchToken, token);
    assert.equal(prefetchRequests[0].mode, 'work'); assert.equal(prefetchRequests[0].projectId, 'p1');
    assert.equal(requests[1].voicePrefetchToken, undefined);
    assert.equal(requests[0].routingMode, 'work'); assert.equal(requests[0].projectId, 'p1');
    assert.equal(requests[1].routingMode, 'life'); assert.equal(requests[1].projectId, null); assert.equal(requests[1].conversationId, 'voice-id');
    assert.equal(requests.length, 3); assert.equal(requests[2].message ?? requests[2].text, '不要离开');
    assert.deepEqual(spoken, ['收到。', '收到。', '收到。', '好的，下次叫我。']); assert.equal(worker.commands.filter(c => c.type === 'answer-finished').length, 3);
    assert.deepEqual(worker.commands.filter(c => c.turn === 4).map(c => c.type), ['dismiss-after-playback', 'speaking', 'dismiss']);
    failTts = true;
    worker.event('turn-start', 5);
    consume({ workerGeneration: 1, audioGeneration: 1, turn: 5, sequence: 0, pcm: Buffer.alloc(320), capturedAt: performance.now() });
    worker.event('turn-end', 5); finalize({ text: '退下', final: true, audioBytes: 320 });
    for (let i = 0; i < 100 && !statuses.includes('failed'); i++) await delay(10);
    assert.ok(statuses.includes('failed'));
    assert.deepEqual(worker.commands.filter(c => c.turn === 5).map(c => c.type), ['dismiss-after-playback', 'dismiss']);
    failTts = false;
    worker.event('turn-start',6);
    consume({workerGeneration:1,audioGeneration:1,turn:6,sequence:0,pcm:Buffer.alloc(320),capturedAt:performance.now()});
    worker.emit('event',{type:'turn-end',generation:1,audioGeneration:1,turn:6,frameCount:1,reason:'max-duration'});
    finalize({text:'新建尚未说完的任务',final:true,audioBytes:320});
    for(let i=0;i<100&&!worker.commands.some(c=>c.turn===6&&c.type==='answer-finished');i++)await delay(10);
    assert.equal(spoken.at(-1),'这段话有点长，本轮没有执行操作，请分段再说一次。');
    assert.deepEqual(worker.commands.filter(c=>c.turn===6).map(c=>c.type),['speaking','answer-finished']);

    assert.equal(requests.length, 3);

  } finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('confirmed standby closes the active archive and next wake starts a new conversation after handoff', {timeout: 8000}, async () => {
  const worker = new Worker();
  const deviceId = '11111111-1111-4111-8111-111111111111';
  const chats: Array<{conversationId: string | null; deviceId?: string}> = [], closes: Array<{conversationId: string; routingMode: string; projectId: string | null; deviceId?: string}> = [];
  let releaseClose!: () => void;
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.url === '/api/voice/session-close') {
      closes.push(JSON.parse(body)); await closeGate; response.end('{}'); return;
    }
    if (request.url === '/api/voice/memory-prefetch') { response.end('{}'); return; }
    const chat = JSON.parse(body) as { conversationId: string | null; deviceId?: string };
    chats.push(chat);
    const conversationId = chat.conversationId || `conversation-${chats.length}`;
    response.end(JSON.stringify({type:'done',answer:'收到。',conversationId})+'\n');
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let consume!: (packet: any) => boolean, finalize!: (value: any) => void, history: string | null = null;
  const statuses: string[] = [];
  const runtime = createNativeVoiceRuntime({settings:()=>settings,key:()=> 'fixture',chatBaseUrl:`http://127.0.0.1:${address.port}`,deviceId,
    conversation:{read:()=>history,save:id=>{history=id;},clear:()=>{const old=history;history=null;return old;}},
    createWorker:callback=>{consume=callback;return worker;},
    createPlayer:()=>({async playStream(_key,audio){for await(const _pcm of audio){}}}),
    connectAsr:(()=>{const result=new Promise<any>(resolve=>{finalize=resolve});return {ready:Promise.resolve(),result,append:()=>true,finish:()=>result,cancel(){}}}) as any,
    connectTts:(()=>{let done!:()=>void;const gate=new Promise<void>(resolve=>{done=resolve});return {ready:Promise.resolve(),append(){return true;},finish(){done();return true;},cancel(){done();},audio:{async *[Symbol.asyncIterator](){await gate;yield Buffer.alloc(320);}}};}) as any,
    onStatus:event=>statuses.push(event.type)
  });
  async function ask(turn:number) {
    worker.event('turn-start',turn);
    consume({workerGeneration:1,audioGeneration:1,turn,sequence:0,pcm:Buffer.alloc(320),capturedAt:performance.now()});
    worker.event('turn-end',turn); finalize({text:'继续说',final:true,audioBytes:320});
  }
  async function waitFinished(count:number) {
    for(let i=0;i<200&&statuses.filter(item=>item==='finished').length<count;i++)await delay(10);
    assert.equal(statuses.filter(item=>item==='finished').length,count);
  }
  try {
    await runtime.start();
    await ask(1);await waitFinished(1);
    await ask(2);await waitFinished(2);
    assert.deepEqual(chats.map(item=>item.conversationId),[null,'conversation-1']);
    assert.deepEqual(chats.map(item=>item.deviceId),[deviceId,deviceId]);
    assert.equal(history,'conversation-1');
    worker.event('standby',2);
    assert.equal(history,null);
    worker.event('standby',2);
    worker.emit('event',{type:'standby',generation:0,audioGeneration:1,turn:99});
    for(let i=0;i<100&&!closes.length;i++)await delay(10);
    assert.deepEqual(closes,[{conversationId:'conversation-1',routingMode:'work',projectId:'p1',deviceId}]);
    await ask(3);
    await delay(60);
    assert.equal(chats.length,2,'new chat waits for the close snapshot to become durable');
    releaseClose();await waitFinished(3);
    assert.deepEqual(chats.map(item=>item.conversationId),[null,'conversation-1',null]);
    assert.equal(chats[2].deviceId,deviceId);
    assert.equal(history,'conversation-3');
  } finally {
    releaseClose();await runtime.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('unacknowledged close survives failure and blocks the next chat until retry succeeds', {timeout: 8000}, async () => {
  const worker = new Worker();
  const deviceId = '22222222-2222-4222-8222-222222222222';
  let closeAccepted = false, closeRequests = 0, chatRequests = 0;
  const acknowledged: string[] = [], statuses: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.url === '/api/voice/session-close') {
      assert.equal(JSON.parse(body).deviceId, deviceId);
      closeRequests++;
      response.statusCode = closeAccepted ? 200 : 503;
      response.end('{}');
      return;
    }
    if (request.url === '/api/voice/memory-prefetch') { response.end('{}'); return; }
    const chat = JSON.parse(body);
    assert.equal(chat.conversationId, null);
    assert.equal(chat.deviceId, deviceId);
    chatRequests++;
    response.end(JSON.stringify({type:'done',answer:'继续。',conversationId:'new-conversation'})+'\n');
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let consume!: (packet: any) => boolean, finalize!: (value: any) => void, history: string | null = null;
  const runtime = createNativeVoiceRuntime({settings:()=>settings,key:()=> 'fixture',chatBaseUrl:`http://127.0.0.1:${address.port}`,deviceId,
    initialSessionCloses:[{conversationId:'old-conversation',routingMode:'work',projectId:'p1'}],
    onSessionCloseAcknowledged:id=>acknowledged.push(id),
    conversation:{read:()=>history,save:id=>{history=id;},clear:()=>{const old=history;history=null;return old;}},
    createWorker:callback=>{consume=callback;return worker;},
    createPlayer:()=>({async playStream(_key,audio){for await(const _pcm of audio){}}}),
    connectAsr:(()=>{const result=new Promise<any>(resolve=>{finalize=resolve});return {ready:Promise.resolve(),result,append:()=>true,finish:()=>result,cancel(){}}}) as any,
    connectTts:(()=>{let done!:()=>void;const gate=new Promise<void>(resolve=>{done=resolve});return {ready:Promise.resolve(),append(){return true;},finish(){done();return true;},cancel(){done();},audio:{async *[Symbol.asyncIterator](){await gate;yield Buffer.alloc(320);}}};}) as any,
    onStatus:event=>statuses.push(event.type)
  });
  async function ask(turn:number) {
    worker.event('turn-start',turn);
    consume({workerGeneration:1,audioGeneration:1,turn,sequence:0,pcm:Buffer.alloc(320),capturedAt:performance.now()});
    worker.event('turn-end',turn); finalize({text:'继续说',final:true,audioBytes:320});
  }
  try {
    await runtime.start();
    await ask(1);
    for(let i=0;i<200&&!statuses.includes('failed');i++)await delay(10);
    assert.ok(statuses.includes('failed'));
    assert.ok(closeRequests>=2,'the pending close is retried before chat');
    assert.equal(chatRequests,0);
    assert.deepEqual(acknowledged,[]);
    closeAccepted = true;
    await ask(2);
    for(let i=0;i<200&&!statuses.includes('finished');i++)await delay(10);
    assert.ok(statuses.includes('finished'));
    assert.equal(chatRequests,1);
    assert.deepEqual(acknowledged,['old-conversation']);
    assert.equal(history,'new-conversation');
  } finally {
    await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('first idle farewell needs no recognition snapshot or Agent and is not repeated', async () => {
  const worker = new Worker(), spoken: string[] = [], statuses: string[] = [];
  let asrCalls = 0;
  const runtime = createNativeVoiceRuntime({ settings: () => settings, key: () => 'fixture', chatBaseUrl: 'http://127.0.0.1:1',
    conversation: { read: () => null, save() { throw Error('idle must not create chat history'); }, clear: () => null },
    createWorker: () => worker,
    createPlayer: () => ({ async playStream(_key, audio) { for await (const _pcm of audio) {} } }),
    connectAsr: (() => { asrCalls++; throw Error('idle must not use ASR'); }) as any,
    connectTts: (() => { let done!: () => void; const gate = new Promise<void>(resolve => { done = resolve; }); return {
      ready: Promise.resolve(), append(text: string) { spoken.push(text); return true; }, finish() { done(); return true; }, cancel() { done(); },
      audio: { async *[Symbol.asyncIterator]() { await gate; yield Buffer.alloc(320); } }
    }; }) as any,
    onStatus: event => statuses.push(event.type)
  });
  try {
    await runtime.start(); worker.event('idle-farewell', 1); worker.event('idle-farewell', 1);
    for (let i = 0; i < 100 && !statuses.includes('finished'); i++) await delay(10);
    assert.ok(statuses.includes('finished')); assert.ok(!statuses.includes('failed'));
    assert.equal(asrCalls, 0); assert.deepEqual(spoken, [IDLE_FAREWELL]);
    assert.equal(worker.commands.at(-1)?.type, 'dismiss');
  } finally { await runtime.close(); }
});


test('custom idle farewell is synthesized once and returns to standby without Agent', async () => {
  const worker = new Worker(), spoken: string[] = [], statuses: string[] = [];
  let asrCalls = 0;
  const runtime = createNativeVoiceRuntime({ settings: () => ({...settings,voiceFarewellText:"主人，我先休息啦。"}), key: () => 'fixture', chatBaseUrl: 'http://127.0.0.1:1',
    conversation: { read: () => null, save() { throw Error('idle must not create chat history'); }, clear: () => null },
    createWorker: () => worker,
    createPlayer: () => ({ async playStream(_key, audio) { for await (const _pcm of audio) {} } }),
    connectAsr: (() => { asrCalls++; throw Error('idle must not use ASR'); }) as any,
    connectTts: (() => { let done!: () => void; const gate = new Promise<void>(resolve => { done = resolve; }); return {
      ready: Promise.resolve(), append(text: string) { spoken.push(text); return true; }, finish() { done(); return true; }, cancel() { done(); },
      audio: { async *[Symbol.asyncIterator]() { await gate; yield Buffer.alloc(320); } }
    }; }) as any,
    onStatus: event => statuses.push(event.type)
  });
  try {
    await runtime.start(); worker.event('idle-farewell', 1); worker.event('idle-farewell', 1);
    for (let i = 0; i < 100 && !statuses.includes('finished'); i++) await delay(10);
    assert.ok(statuses.includes('finished')); assert.ok(!statuses.includes('failed'));
    assert.equal(asrCalls, 0); assert.deepEqual(spoken, ["主人，我先休息啦。"]);
    assert.equal(worker.commands.at(-1)?.type, 'dismiss');
  } finally { await runtime.close(); }
});


test('candidate ASR resumes or hands off without reaching Agent, ignores retired audio', async () => {
  const worker = new Worker() as Worker & { resolveInterruption: (key: any, decision: string) => boolean };
  const decisions: string[] = [], paused: any[] = [], resumed: any[] = [];
  worker.resolveInterruption = (_key, decision) => { decisions.push(decision); return true; };
  let consume: any, finalize: any, sessions = 0;
  const runtime = createNativeVoiceRuntime({ settings: () => settings, key: () => 'fixture', chatBaseUrl: 'http://127.0.0.1:1',
    conversation: { read: () => null, save() { throw Error('candidate cannot save history'); }, clear: () => null },
    createWorker: (_normal, candidate) => { consume = candidate; return worker; },
    createPlayer: () => ({ async playStream() { throw Error('candidate cannot synthesize'); },
      pause(key) { paused.push(key); return true; }, resume(key) { resumed.push(key); return true; } }),
    connectAsr: (() => { sessions++; const result = new Promise<any>(resolve => { finalize = resolve; });
      return { ready: Promise.resolve(), result, append: () => true, finish: () => result, cancel() {} }; }) as any
  });
  const event = (type: string, pauseId: number, phase?: string) => worker.emit('event', { type, phase, generation: 1, audioGeneration: 1, turn: 1, pauseId, frameCount: 1 });
  try {
    await runtime.start();
    for (const [pauseId, text] of [[1, '嗯'], [2, '重新安排']] as const) {
      event('interruption-start', pauseId);
      assert.equal(consume({ workerGeneration: 1, audioGeneration: 1, turn: 1, pauseId, sequence: 0, pcm: Buffer.alloc(320), capturedAt: performance.now() }), true);
      event('interruption-end', pauseId); finalize({ final: true, text, audioBytes: 320 }); await delay(0);
    }
    assert.deepEqual(decisions, ['resume','interrupt']); assert.equal(sessions,2);
    assert.equal(paused[0].generation,1); assert.equal(resumed.length,1);
    event('interruption-start',3,'processing');
    assert.equal(paused.length,2); // No playback exists to pause before response setup.
    consume({workerGeneration:1,audioGeneration:1,turn:1,pauseId:3,sequence:0,pcm:Buffer.alloc(320),capturedAt:performance.now()});
    event('interruption-start',2,'processing');assert.equal(sessions,3); // Stale start cannot retire this candidate.
    event('interruption-end',3);finalize({final:true,text:'重新安排',audioBytes:320});await delay(0);
    assert.deepEqual(decisions,['resume','interrupt','interrupt']);

    event('interruption-start',4); worker.event('turn-cancelled',1);
    finalize({ final: true, text: '迟到指令', audioBytes: 320 }); await delay(0);
    assert.deepEqual(decisions,['resume','interrupt','interrupt']);
    assert.equal(consume({ workerGeneration: 1, audioGeneration: 1, turn: 1, pauseId: 3, sequence: 1, pcm: Buffer.alloc(320), capturedAt: performance.now() }),true);
  } finally { await runtime.close(); }
});

test('native preview uses saved synthesis settings without ASR or Agent and returns to standby', async () => {
  const worker = new Worker(), spoken: string[] = [], statuses: string[] = [];
  let asrCalls = 0;
  const runtime = createNativeVoiceRuntime({ settings: () => settings, key: () => 'fixture', chatBaseUrl: 'http://127.0.0.1:1',
    conversation: { read: () => null, save() { throw Error('idle must not create chat history'); }, clear: () => null },
    createWorker: () => worker,
    createPlayer: () => ({ async playStream(_key, audio) { for await (const _pcm of audio) {} } }),
    connectAsr: (() => { asrCalls++; throw Error('idle must not use ASR'); }) as any,
    connectTts: (() => { let done!: () => void; const gate = new Promise<void>(resolve => { done = resolve; }); return {
      ready: Promise.resolve(), append(text: string) { spoken.push(text); return true; }, finish() { done(); return true; }, cancel() { done(); },
      audio: { async *[Symbol.asyncIterator]() { await gate; yield Buffer.alloc(320); } }
    }; }) as any,
    onStatus: event => statuses.push(event.type)
  });
  try {
    await runtime.start(); worker.event('voice-preview', 1); worker.event('voice-preview', 1);
    for (let i = 0; i < 100 && !statuses.includes('finished'); i++) await delay(10);
    assert.ok(statuses.includes('finished')); assert.ok(!statuses.includes('failed'));
    assert.equal(asrCalls, 0); assert.equal(spoken.join(''), '这是希微的语音试听，正在使用已保存的音色、语速和音量。试听结束后，我会回到待机。');
    assert.equal(worker.commands.at(-1)?.type, 'dismiss');
  } finally { await runtime.close(); }
});

test('spoken progress preference affects later turns only until standby, without an Agent control request', {timeout:12000}, async()=>{
  const worker=new Worker();let consume:any,finalize:any,requests=0,cacheReads=0;const spoken:string[]=[],statuses:string[]=[];
  const server=createServer(async(request,response)=>{
    for await(const _chunk of request){}requests++;
    const now=Date.now();response.write(JSON.stringify({type:'voice-progress',eventId:'e1',sessionId:'s',turnId:'t'+requests,sequence:1,operationId:'op',planRevision:1,configRevision:1,stage:'retrieval',status:'running',occurredAt:now,expiresAt:now+5000})+'\n');
    await delay(1400);response.end(JSON.stringify({type:'delta',delta:'这是最终结果。'})+'\n'+JSON.stringify({type:'done',answer:'这是最终结果。',conversationId:'c'})+'\n');
  });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  const config={...settings,voiceProgressMode:'concise' as const,voiceProgressFirstMs:1000};
  const runtime=createNativeVoiceRuntime({settings:()=>config,key:()=> 'fixture',chatBaseUrl:`http://127.0.0.1:${address.port}`,conversation:{read:()=>null,save(){},clear:()=>null},
    createWorker:callback=>{consume=callback;return worker;},createPlayer:()=>({async playStream(_key,audio){for await(const _pcm of audio){}}}),
    connectAsr:(()=>{const result=new Promise<any>(resolve=>{finalize=resolve});return{ready:Promise.resolve(),result,append:()=>true,finish:()=>result,cancel(){}}}) as any,
    connectTts:(()=>{let done!:()=>void;const gate=new Promise<void>(resolve=>{done=resolve});return{ready:Promise.resolve(),append(text:string){spoken.push(text);return true;},finish(){done();return true;},cancel(){done();},audio:{async *[Symbol.asyncIterator](){await gate;yield Buffer.alloc(320)}}}}) as any,
    cachedProgress:()=>{cacheReads++;return Buffer.alloc(320);},onStatus:event=>statuses.push(event.type)
  });
  async function ask(turn:number,text:string){worker.event('turn-start',turn);consume({workerGeneration:1,audioGeneration:1,turn,sequence:0,pcm:Buffer.alloc(320),capturedAt:performance.now()});worker.event('turn-end',turn);finalize({text,final:true,audioBytes:320});for(let i=0;i<400&&statuses.filter(s=>s==='finished').length<turn;i++)await delay(10);assert.equal(statuses.filter(s=>s==='finished').length,turn);}
  try{await runtime.start();await ask(1,'关闭过程播报');assert.equal(requests,0);assert.match(spoken[0],/已关闭过程播报/);await ask(2,'查询项目');assert.equal(requests,1);assert.equal(cacheReads,0);assert.equal(spoken.at(-1),'这是最终结果。');assert.equal(config.voiceProgressMode,'concise');worker.event('standby',1); // Late prior-turn standby must not clear the current session override.
    worker.emit('event',{type:'ready',generation:1}); // Duplicate ready must not reset it either.
    worker.emit('fault',{generation:0});
    worker.emit('event',{type:'standby',generation:0,audioGeneration:1,turn:99});
    await ask(3,'继续查询');assert.equal(requests,2);assert.equal(cacheReads,0);
    worker.event('standby',3);await ask(4,'再次查询');assert.equal(requests,3);assert.ok(cacheReads>0);assert.equal(spoken.at(-1),'这是最终结果。');}
  finally{await runtime.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
