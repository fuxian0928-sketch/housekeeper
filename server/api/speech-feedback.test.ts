import assert from 'node:assert/strict';
import test from 'node:test';
import type { Express } from 'express';
import type { SettingsService } from '../domain/settings/settings-service.js';
import { registerSpeechRoutes } from './speech.js';
import wavefile from 'wavefile';
test('feedback cache coalesces requests and follows voice/service changes', async()=>{
 const routes=new Map<string, Function>();
 const settings={speechServiceBaseUrl:'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1',speechSynthesisModel:'fixture',speechVoice:'voice1',speechInstruction:''};
 const service={current:()=>settings,effectiveApiKey:()=> 'fixture-key'} as unknown as SettingsService;
 registerSpeechRoutes({post:(path:string,fn:Function)=>routes.set(path,fn)} as unknown as Express,service);
 const original=globalThis.fetch;let syntheses=0;
 const wave=new wavefile.WaveFile();wave.fromScratch(1,16000,'16',[0,1000,-1000,0]);
 globalThis.fetch=(async (_url,init)=>{
  if(init?.method==='POST'){syntheses++;return Response.json({output:{audio:{url:'https://audio.example/clip.wav'}}});}
  return new Response(new Uint8Array(wave.toBuffer()),{headers:{'content-type':'audio/wav'}});
 }) as typeof fetch;
 const invoke=async()=>{let body:unknown;await routes.get('/api/speech/feedback')!({}, {json:(value:unknown)=>{body=value},status:()=>{throw Error('cache failed')}});return body;};
 try {
  const [a,b]=await Promise.all([invoke(),invoke()]);assert.deepEqual(a,b);assert.equal(syntheses,6);
  await invoke();assert.equal(syntheses,6);
  settings.speechVoice='voice2';await invoke();assert.equal(syntheses,12);
  settings.speechServiceBaseUrl='https://another.cn-beijing.maas.aliyuncs.com/api/v1';await invoke();assert.equal(syntheses,18);
 }finally{globalThis.fetch=original;}
});
