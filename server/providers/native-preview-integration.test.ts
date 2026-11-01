import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeConversationOwner } from './native-conversation-owner.js';
const {VoiceWorkerSupervisor}=createRequire(import.meta.url)('../../electron/voice-worker-supervisor.cjs');

test('real Python preview events cross supervisor pipes and retire old responses', {timeout:10000},async()=>{
 let worker:any;
 const responses:any[]=[],events:any[]=[],statuses:any[]=[];
 const owner=createNativeConversationOwner(consume=>{
  worker=new VoiceWorkerSupervisor({executable:process.env.VOICE_TEST_PYTHON || 'python',args:['-u','-B',fileURLToPath(new URL('../../scripts/voice-lab/preview_protocol_fixture.py',import.meta.url))],audioConsumer:consume});
  worker.on('event',(event:any)=>events.push(event));
  return worker;
 },{
  createSession(){throw Error('preview must not request recognition');},
  respond:context=>new Promise<void>(resolve=>responses.push({context,resolve})),
  onStatus:event=>statuses.push(event)
 });
 const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await delay(10);assert.ok(check(),'expected protocol event');};
 try{
  await owner.start();
  assert.equal(worker.sessionControl('voice-preview'),true);
  await until(()=>responses.length===1);
  assert.equal(responses[0].context.control,'voice-preview');
  assert.equal(responses[0].context.text,'');
  assert.equal(responses[0].context.beginPlayback(),true);
  assert.equal(worker.sessionControl('voice-preview'),true);
  await until(()=>responses.length===2);
  assert.equal(responses[0].context.signal.aborted,true);
  assert.equal(responses[0].context.beginPlayback(),false);
  responses[0].resolve();await delay(30);
  assert.equal(statuses.filter(e=>e.type==='finished').length,0);
  assert.equal(responses[1].context.beginPlayback(),true);
  responses[1].resolve();
  await until(()=>events.some(e=>e.type==='standby'&&e.turn===2));
  assert.equal(statuses.filter(e=>e.type==='finished').length,1);
  assert.equal(statuses.some(e=>e.type==='failed'),false);
  assert.equal(events.filter(e=>e.type==='voice-preview').length,2);
  assert.equal(events.some(e=>e.type==='turn-start'),false);
 }finally{await owner.close();}
});

test('early ASR failure recovers the actual Python capture state over control pipes',{timeout:10000},async()=>{
 const events:any[]=[],statuses:any[]=[];
 const owner=createNativeConversationOwner(consume=>{
  const worker=new VoiceWorkerSupervisor({executable:process.env.VOICE_TEST_PYTHON||'python',args:['-u','-B',fileURLToPath(new URL('../../scripts/voice-lab/recovery_protocol_fixture.py',import.meta.url))],audioConsumer:consume});
  worker.on('event',(event:any)=>events.push(event));return worker;
 },{createSession(){throw Error('provider unavailable');},async respond(){throw Error('unexpected response');},onStatus:event=>statuses.push(event)});
 try{
  await owner.start();
  for(let i=0;i<200&&!events.some(e=>e.type==='listening');i++)await delay(10);
  assert.ok(events.some(e=>e.type==='listening'&&e.turn===1));
  assert.equal(events.filter(e=>e.type==='turn-start').length,1);
  assert.deepEqual(statuses.map(e=>e.code),['ASR_START_FAILED']);
 }finally{await owner.close();}
});
