import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { progressStages } from '../domain/voice-progress.js';
import { createVoiceProgressCache } from './voice-progress-cache.js';
const profile={synthesisBaseUrl:'https://example.test',synthesisModel:'fixture',voice:'one'};
const fixture = () => ({ ready: Promise.resolve(),append:()=>true,finish:()=>true,cancel(){},audio:{async *[Symbol.asyncIterator](){yield Buffer.alloc(400,7);}} });

test('prewarms serially and keeps bounded aligned copies for one voice only',async()=>{
  let calls=0;
  const c=createVoiceProgressCache(()=>{calls++;return fixture();},{idleMs:0});
  c.idle(profile); await delay(30);
  assert.equal(calls,progressStages.length); const pcm=c.get(profile,'model')!; assert.equal(pcm.length,640);
  pcm.fill(0); assert.equal(c.get(profile,'model')![0],7);
  assert.equal(c.get({...profile,voice:'two'},'model'),null);
  c.idle(profile); await delay(10); assert.equal(calls,progressStages.length);
  c.close(); assert.equal(c.get(profile,'model'),null);
});

test('foreground work aborts prewarm and late audio cannot repopulate cache',async()=>{
  let signal!:AbortSignal,release!:(value:IteratorResult<Buffer>)=>void,calls=0;
  const c=createVoiceProgressCache((_profile,s)=>{signal=s;calls++;return {...fixture(),audio:{[Symbol.asyncIterator](){return {next:()=>new Promise<IteratorResult<Buffer>>(resolve=>{release=resolve;})};}}};},{idleMs:0});
  c.idle(profile); await delay(10);c.busy();assert.equal(signal.aborted,true);
  release({done:false,value:Buffer.alloc(320)});await delay(10);
  assert.equal(c.get(profile,'model'),null);assert.equal(calls,1);c.close();
});

test('oversized audio is rejected and failures have at most two attempts per phrase',async()=>{
  let calls=0;
  const c=createVoiceProgressCache(()=>{calls++;return {...fixture(),audio:{async *[Symbol.asyncIterator](){yield Buffer.alloc(96002);}}};},{idleMs:0});
  for(let i=0;i<3;i++){c.idle(profile);await delay(10);}
  assert.equal(calls,progressStages.length*2);assert.equal(c.get(profile,'model'),null);c.close();
});

test('timeout bounds an uncooperative provider and profile change discards old clips',async()=>{
  const c=createVoiceProgressCache(p=>p.voice==='one'?fixture():{...fixture(),ready:new Promise<void>(()=>{})},{idleMs:0,timeoutMs:10});
  c.idle(profile);await delay(10);assert.ok(c.get(profile,'model'));
  c.idle({...profile,voice:'two'});assert.equal(c.get(profile,'model'),null);
  await delay(70);assert.equal(c.get({...profile,voice:'two'},'model'),null);c.close();
});


test('speech-rate changes invalidate cached prompts and prewarm the new profile',async()=>{
  const rates: number[]=[];
  const c=createVoiceProgressCache(p=>{rates.push(p.voiceSpeechRate ?? 1);return fixture();},{idleMs:0});
  try {
    c.idle(profile);await delay(30);
    assert.ok(c.get({...profile,voiceSpeechRate:1},'model'));
    const faster={...profile,voiceSpeechRate:1.25};
    assert.equal(c.get(faster,'model'),null);
    c.idle(faster);assert.equal(c.get(profile,'model'),null);await delay(30);
    assert.ok(c.get(faster,'model'));
    assert.equal(rates.filter(r=>r===1.25).length,progressStages.length);
  } finally {c.close();}
});
