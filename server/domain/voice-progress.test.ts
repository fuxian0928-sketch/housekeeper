import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceProgressSource, readVoiceProgress, type VoiceProgressEvent } from './voice-progress.js';
import { createVoiceProgressScheduler } from './voice-progress-scheduler.js';

test('only known orchestration phases generate metadata, never skill-loaded or raw labels', () => {
  const events: VoiceProgressEvent[] = [];
  const source = createVoiceProgressSource('session','turn',e=>events.push(e),()=>1000);
  source('skills','done'); source('skill-tools','active'); source('retrieve','active'); source('retrieve','done');
  assert.equal(events.length,2); assert.equal(events[0].stage,'retrieval'); assert.equal(events[1].status,'succeeded');
  const safe = readVoiceProgress({...events[0],text:'secret',reasoning:'private'},1001)!;
  assert.ok(!('text' in safe)); assert.ok(!('reasoning' in safe));
  assert.equal(readVoiceProgress(events[0],6000),null);
});

test('fast tasks stay silent; result invalidates queued progress permanently', () => {
  let now=1000; const s=createVoiceProgressScheduler({mode:'concise',now:()=>now});
  const source=createVoiceProgressSource('s','t',e=>s.accept(e),()=>now);
  source('retrieve','active'); assert.equal(s.next(),null);
  now=3000; const item=s.next()!; assert.equal(item.phrase,'我正在查找相关资料。');
  s.finish(); assert.equal(s.canPlay(item.event),false); source('generate','active'); assert.equal(s.next(),null);
});

test('new phase replaces stale selection, cooldown counts actual start, no fake heartbeat', () => {
  let now=1000; const s=createVoiceProgressScheduler({mode:'concise',now:()=>now});
  const source=createVoiceProgressSource('s','t',e=>s.accept(e),()=>now);
  source('retrieve','active'); now=3000; const old=s.next()!;
  source('retrieve','done'); source('generate','active');
  assert.equal(s.canPlay(old.event),false); assert.equal(s.started(s.next()!.event),true);
  now=11000; assert.equal(s.next(),null); // Eight seconds later is not proof work is still running.
  source('generate','active'); assert.equal(s.started(s.next()!.event),true);
  now=19000; source('generate','active'); assert.equal(s.next(),null); // One repeat maximum.
});

test('duplicate, old sequence, cross-turn and old plan events cannot revive progress', () => {
  let now=1000; const events:VoiceProgressEvent[]=[];
  const source=createVoiceProgressSource('s','t',e=>events.push(e),()=>now); source('retrieve','active'); source('generate','active');
  const s=createVoiceProgressScheduler({mode:'detailed',now:()=>now});
  assert.equal(s.accept({...events[1],planRevision:2}),true);
  assert.equal(s.accept(events[1]),false); assert.equal(s.accept(events[0]),false);
  assert.equal(s.accept({...events[1],sequence:3,turnId:'other',planRevision:2}),false);
  assert.equal(s.accept({...events[1],sequence:4,planRevision:1}),false);
});

test('off mode is silent and invalid preferences fail early', () => {
  assert.throws(()=>createVoiceProgressScheduler({mode:'concise',firstDelayMs:0}));
  const s=createVoiceProgressScheduler({mode:'off'}); assert.equal(s.next(),null);
});

test('actual tool executions share ordering with orchestration and terminal events invalidate speech',()=>{
 let now=1000;const events:VoiceProgressEvent[]=[];const source=createVoiceProgressSource('s','t',e=>events.push(e),()=>now);
 source('skill-tools','active');source.tool('model-invented-id','running');assert.equal(events.length,0);
 const id='11111111-1111-4111-8111-111111111111';source.tool(id,'running');
 const scheduler=createVoiceProgressScheduler({mode:'concise',now:()=>now});scheduler.accept(events[0]);now=3000;
 const item=scheduler.next()!;assert.equal(item.phrase,'我正在调用工具处理这件事。');
 source.tool(id,'succeeded');scheduler.accept(events[1]);assert.equal(scheduler.canPlay(item.event),false);
 source('generate','active');assert.deepEqual(events.map(e=>e.sequence),[1,2,3]);
});
