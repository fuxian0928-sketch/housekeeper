import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Express } from 'express';
import { registerRealtimeSpeechRoutes } from './realtime-speech.js';
import type { createQwenRealtimeAsr, RealtimeAsrOptions } from '../providers/qwen-realtime-asr.js';

class Response extends EventEmitter {
  writableEnded=false; code=200; body: any;
  status(code: number) {this.code=code;return this;}
  json(body: unknown) {this.body=body;this.writableEnded=true;return this;}
}
const settings={current:()=>({speechServiceBaseUrl:'https://dashscope.aliyuncs.com',speechRealtimeRecognitionModel:'qwen3-asr-flash-realtime'}),effectiveApiKey:()=> 'fixture-key'};
function setup(ready: (options: RealtimeAsrOptions)=>Promise<void>) {
  let route!: (request:unknown,response:Response)=>Promise<void>;
  let captured: RealtimeAsrOptions | undefined;
  const connect=(options: RealtimeAsrOptions)=>{captured=options;return {ready:ready(options)} as ReturnType<typeof createQwenRealtimeAsr>;};
  registerRealtimeSpeechRoutes({post:(_path:string,handler:typeof route)=>{route=handler;}} as unknown as Express,settings,connect);
  return {invoke:(response=new Response())=>({response,done:route({},response)}),options:()=>captured!};
}

test('probe reports handshake only, then cancels cloud session', async()=>{
  const probe=setup(async()=>{}), {response,done}=probe.invoke(); await done;
  assert.equal(response.body.connected,true);assert.equal(response.body.recognitionVerified,false);
  assert.equal(probe.options().signal.aborted,true);
  assert.equal(JSON.stringify(response.body).includes('fixture-key'),false);
});
test('duplicate probes are bounded and disconnect cancels pending handshake', async()=>{
  const probe=setup(options=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('ASR_CANCELLED')))));
  const first=probe.invoke(); const second=probe.invoke(); await second.done;
  assert.equal(second.response.code,409);
  first.response.emit('close');await first.done;
  assert.equal(first.response.body,undefined);assert.equal(probe.options().signal.aborted,true);
});
test('provider errors are translated without exposing raw messages',async()=>{
  const probe=setup(async()=>{throw new Error('secret-key-private-provider-error');});
  const {response,done}=probe.invoke();await done;
  assert.equal(response.code,502);assert.equal(JSON.stringify(response.body).includes('secret'),false);
  assert.equal(response.listenerCount('close'),0);
});
