import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createNativeRecognitionOwner, createConfiguredNativeRecognitionOwner } from './native-recognition-owner.js';
import { EventEmitter } from 'node:events';
import { createQwenRealtimeAsr } from './qwen-realtime-asr.js';
import WebSocket, { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const { VoiceWorkerSupervisor } = require('../../electron/voice-worker-supervisor.cjs');

test('missing realtime configuration fails before opening microphone', async () => {
  let starts=0;
  const worker=Object.assign(new EventEmitter(),{start:async()=>{starts++;return {generation:1};},stop:async()=>{}});
  const owner=createConfiguredNativeRecognitionOwner(()=>worker,{current:()=>({speechServiceBaseUrl:'https://dashscope.aliyuncs.com'}),effectiveApiKey:()=>null},()=>{});
  try { await assert.rejects(owner.start(),/ASR_REALTIME_NOT_CONFIGURED/); assert.equal(starts,0); }
  finally {await owner.close();}
});

test('worker PCM reaches realtime adapter and returns one final with matching turn', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.once('listening', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let bytes = 0;
  server.on('connection', socket => socket.on('message', data => {
    const event = JSON.parse(data.toString());
    if (event.type === 'session.update') socket.send(JSON.stringify({type:'session.updated'}));
    if (event.type === 'input_audio_buffer.append') bytes += Buffer.from(event.audio,'base64').length;
    if (event.type === 'input_audio_buffer.commit') socket.send(JSON.stringify({type:'input_audio_buffer.committed',item_id:'one'}));
    if (event.type === 'session.finish') {
      socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'one',transcript:'测试任务'}));
      socket.send(JSON.stringify({type:'session.finished'}));
    }
  }));
  const script = `console.log(JSON.stringify({type:'ready'}));let sent=false;process.stdin.on('data',d=>{for(const l of d.toString().trim().split('\\n')){const m=JSON.parse(l);if(m.type!=='ping')process.exit(0);console.log(JSON.stringify({type:'alive',token:m.token,workerClockMs:performance.now()}));if(!sent){sent=true;console.log(JSON.stringify({type:'turn-start',generation:1,turn:1}));const now=performance.now();for(let i=0;i<10;i++)console.log(JSON.stringify({type:'audio',generation:1,turn:1,sequence:i,capturedAtMs:now-100+i*10,pcm:Buffer.alloc(320).toString('base64')}));console.log(JSON.stringify({type:'turn-end',generation:1,turn:1,frameCount:10}));}}});`;
  let finish!: (event: any) => void;
  const done = new Promise<any>(r => { finish = r; });
  const owner = createNativeRecognitionOwner(consume => new VoiceWorkerSupervisor({ executable:process.execPath,args:['-e',script],audioConsumer:consume }), {
    createSession: (signal,onPartial) => createQwenRealtimeAsr({signal,onPartial,baseUrl:'https://dashscope.aliyuncs.com',model:'test',apiKey:'test',createSocket:()=>new WebSocket(`ws://127.0.0.1:${address.port}`)}),
    onEvent: event => finish(event)
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await owner.start();
    const result = await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('TEST_TIMEOUT')),3000);})]);
    assert.deepEqual(result,{workerGeneration:1,audioGeneration:1,turn:1,type:'final',text:'测试任务'});
    assert.equal(bytes,3200);
  } finally {
    clearTimeout(timer); await owner.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(r=>server.close(()=>r()));
  }
});
