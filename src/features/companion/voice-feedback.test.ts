import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createVoiceFeedback, feedbackStage} from './voice-feedback';
const clips={thinking:[{text:'think',audioDataUrl:'think'}],retrieval:[{text:'search',audioDataUrl:'search'}],vision:[{text:'see',audioDataUrl:'see'}]};
test('only actual active stage selects feedback',()=>{
 assert.equal(feedbackStage({type:'analysis',id:'retrieve',status:'done'}),null);
 assert.equal(feedbackStage({type:'analysis',id:'retrieve',status:'active'}),'retrieval');
 assert.equal(feedbackStage({type:'analysis',id:'vision',status:'active'}),'vision');
 assert.equal(feedbackStage({type:'analysis',id:'generate',status:'active'}),'thinking');
 assert.equal(feedbackStage({type:'routing',domain:'chat'}),null);
});
test('fast answers and missing audio stay quiet',async()=>{
 for(const cached of [clips,{}]){
 let plays=0;const f=createVoiceFeedback({signal:new AbortController().signal,clips:()=>cached,play:async()=>{plays++},delays:[10,30]});
 f.onEvent({type:'analysis',id:'generate',status:'active'});if(cached===clips)await f.finish();await delay(50);f.cancel();assert.equal(plays,0);
 }
});
test('two cues use current actual phase rather than guessed phase',async()=>{
 const played:string[]=[];const f=createVoiceFeedback({signal:new AbortController().signal,clips:()=>clips,play:async clip=>{played.push(clip.text)},delays:[10,60]});
 f.onEvent({type:'analysis',id:'retrieve',status:'active'});await delay(30);f.onEvent({type:'analysis',id:'generate',status:'active'});await delay(60);await f.finish();assert.deepEqual(played,['search','think']);
});
test('finish drains audible cue, cancels pending cue; interrupt cancels playback',async()=>{
 let finishClip!:()=>void;let plays=0;const c=new AbortController();
 const f=createVoiceFeedback({signal:c.signal,clips:()=>clips,play:(_clip,signal)=>new Promise<void>(resolve=>{plays++;finishClip=resolve;signal.addEventListener('abort',()=>resolve(),{once:true})}),delays:[5,60]});
 f.onEvent({type:'analysis',id:'generate',status:'active'});await delay(20);let finished=false;const done=f.finish().then(()=>{finished=true});await delay(10);assert.equal(finished,false);finishClip();await done;await delay(60);assert.equal(plays,1);
 const g=createVoiceFeedback({signal:c.signal,clips:()=>clips,play:(_clip,signal)=>new Promise<void>(resolve=>{signal.addEventListener('abort',()=>{plays++;resolve()},{once:true})}),delays:[5,60]});
 g.onEvent({type:'analysis',id:'vision',status:'active'});await delay(20);c.abort();await delay(70);assert.equal(plays,2);await assert.rejects(g.finish(),{name:'AbortError'});
});
