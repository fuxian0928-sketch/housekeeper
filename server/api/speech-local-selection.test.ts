import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {registerSpeechRoutes} from './speech.js';

test('local selection never invokes legacy cloud speech or its credential lookup',async context=>{
 const app=express();app.use(express.json());let keyReads=0;
 registerSpeechRoutes(app,{current:()=>({speechExecution:'local'}),effectiveApiKey:()=>{keyReads++;throw Error('cloud key must not be read');}} as never);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));context.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const base='http://127.0.0.1:'+((server.address() as {port:number}).port);
 for(const endpoint of ['synthesize','transcribe','connection/test']){
  const response=await fetch(base+'/api/speech/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'仅本机处理'})});
  assert.equal(response.status,409);assert.match((await response.json()).message,/本机语音/);
 }
 const feedback=await fetch(base+'/api/speech/feedback',{method:'POST'});assert.deepEqual(await feedback.json(),{});assert.equal(keyReads,0);
});
