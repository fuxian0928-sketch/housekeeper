import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createNativeVoiceRuntime, type NativeVoiceSettings } from './native-voice-runtime.js';
import { createQwenRealtimeAsr } from './qwen-realtime-asr.js';
import { createQwenRealtimeTts } from './qwen-realtime-tts.js';
import type { NativeAudioPacket } from './native-recognition-owner.js';

class Worker extends EventEmitter {
  starts = 0;
  commands: Array<{turn:number;type:string}> = [];
  async start() { this.starts++; this.emit('event', {type:'ready',generation:1}); return {generation:1}; }
  async stop() { this.emit('closed', {generation:1}); }
  command(value: {turn:number;type:string}) { this.commands.push(value); return true; }
  event(type:string,turn:number) { this.emit('event',{type,generation:1,audioGeneration:1,turn,frameCount:1}); }
}
const settings: NativeVoiceSettings = {
  speechServiceBaseUrl:'https://dashscope.aliyuncs.com/api/v1',speechRealtimeRecognitionModel:'qwen3-asr-flash-realtime',
  synthesisBaseUrl:'https://dashscope.aliyuncs.com/api/v1',synthesisModel:'qwen3-tts-flash-realtime',voice:'Cherry',
  routingMode:'work',projectId:'fixture-project',voiceProgressMode:'off',voicePrefetchEnabled:false
};
type Fault = 'healthy'|'asr-close'|'asr-timeout'|'tts-close'|'tts-timeout'|'chat-truncated';

test('100 successive turns recover from 50 transport faults without restarting or replaying failed audio', {timeout:30000}, async (t) => {
  let fault:Fault='healthy', conversation:string|null=null;
  const http = createServer(async (request,response) => {
    for await (const _chunk of request) { /* Drain fixture request; do not record speech. */ }
    response.setHeader('Content-Type','application/x-ndjson');
    if (fault==='chat-truncated') { response.end('{"type":"delta"'); return; }
    response.end(JSON.stringify({type:'delta',delta:'测试回答。'})+'\n'+JSON.stringify({type:'done',answer:'测试回答。',conversationId:'fixture-conversation'})+'\n');
  });
  http.listen(0,'127.0.0.1'); await once(http,'listening');
  const address=http.address();assert.ok(address && typeof address!=='string');
  const sockets=new WebSocketServer({server:http});
  sockets.on('connection',(socket,request)=>{
    const mode=fault;const asr=request.url==='/asr';
    const send=(type:string,fields={})=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type,...fields}));};
    socket.on('message',raw=>{
      const event=JSON.parse(raw.toString());
      if(event.type==='session.update') {
        if(asr && mode==='asr-close') {socket.terminate();return;}
        if((asr && mode==='asr-timeout') || (!asr && mode==='tts-timeout'))return;
        send('session.updated',asr?{}:{session:{sample_rate:16000,response_format:'pcm',mode:'server_commit'}});
      } else if(asr && event.type==='input_audio_buffer.commit') {
        send('input_audio_buffer.committed',{item_id:'fixture-item'});
        send('conversation.item.input_audio_transcription.completed',{item_id:'fixture-item',transcript:'查询项目进展'});
      } else if(event.type==='session.finish') {
        if(!asr){
          if(mode==='tts-close'){socket.terminate();return;}
          send('response.audio.delta',{delta:Buffer.alloc(320,1).toString('base64')});
        }
        send('session.finished');
      }
    });
  });
  const worker=new Worker(), statuses:Array<{turn:number;type:string;code?:string}>=[], outputTurns:number[]=[];
  let consume!:(packet:NativeAudioPacket)=>boolean;
  const runtime=createNativeVoiceRuntime({settings:()=>settings,key:()=> 'fixture-only',chatBaseUrl:`http://127.0.0.1:${address.port}`,
    conversation:{read:()=>conversation,save:id=>{conversation=id;},clear:()=>{const old=conversation;conversation=null;return old;}},createWorker:callback=>{consume=callback;return worker;},
    createPlayer:()=>({async playStream(key,audio,signal){for await(const pcm of audio){signal.throwIfAborted();assert.equal(pcm.length,320);outputTurns.push(key.turn);}}}),
    connectAsr:options=>createQwenRealtimeAsr({...options,connectMs:120,finalMs:500,totalMs:1500,createSocket:()=>new WebSocket(`ws://127.0.0.1:${address.port}/asr`)}),
    connectTts:options=>createQwenRealtimeTts({...options,connectMs:120,totalMs:1500,createSocket:()=>new WebSocket(`ws://127.0.0.1:${address.port}/tts`)}),
    onStatus:event=>statuses.push(event)
  });
  let turn=0;
  const elapsed:Record<string,number[]>={};
  const expectedCodes:Partial<Record<Fault,string>>={'asr-close':'ASR_CLOSED_BEFORE_FINISH','asr-timeout':'ASR_CONNECT_TIMEOUT','tts-close':'VOICE_SYNTHESIS_FAILED','tts-timeout':'VOICE_SYNTHESIS_FAILED','chat-truncated':'VOICE_ANSWER_FAILED'};
  const run=async(mode:Fault)=>{
    fault=mode;const id=++turn;const started=performance.now();worker.event('turn-start',id);
    assert.equal(consume({workerGeneration:1,audioGeneration:1,turn:id,sequence:0,pcm:Buffer.alloc(6400),capturedAt:performance.now()}),true);
    worker.event('turn-end',id);
    for(let i=0;i<200&&!statuses.some(s=>s.turn===id&&(s.type==='failed'||s.type==='finished'));i++)await delay(10);
    const terminal=statuses.filter(s=>s.turn===id&&(s.type==='failed'||s.type==='finished'));
    assert.equal(terminal.length,1,mode+' must settle once');
    assert.equal(terminal[0].type,mode==='healthy'?'finished':'failed',mode+':'+terminal[0].code);
    assert.equal(terminal[0].code,expectedCodes[mode],mode+' failure classification');
    (elapsed[mode]??=[]).push(Math.round(performance.now()-started));
    assert.equal(worker.commands.at(-1)?.type,mode==='healthy'?'answer-finished':'answer-failed');
    assert.equal(outputTurns.filter(t=>t===id).length,mode==='healthy'?1:0);
    assert.ok(performance.now()-started<2000,'fault/recovery must settle within local test budget');
  };
  try {
    await runtime.start();
    for(const mode of ['asr-close','asr-timeout','tts-close','tts-timeout','chat-truncated'] as const){
      for(let i=0;i<10;i++){await run(mode);await run('healthy');}
    }
    await delay(150);
    assert.equal(worker.starts,1);assert.equal(turn,100);assert.equal(outputTurns.length,50);
    assert.equal(statuses.filter(s=>s.type==='failed').length,50);
    assert.equal(statuses.filter(s=>s.type==='finished').length,50);
    assert.equal(conversation,'fixture-conversation');
    t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(elapsed).map(([mode,values])=>[mode,{count:values.length,maxMs:Math.max(...values)}]))));
    for(let i=0;i<100&&sockets.clients.size;i++)await delay(10);
    assert.equal(sockets.clients.size,0,'finished and failed transports release sockets');
  } finally {
    await runtime.close();for(const socket of sockets.clients)socket.terminate();
    await new Promise<void>(resolve=>sockets.close(()=>resolve()));http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));
  }
});
