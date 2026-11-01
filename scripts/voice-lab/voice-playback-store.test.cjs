const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPlaybackStore}=require('../../electron/voice-playback-store.cjs');
const base={conversationId:'c',assistantMessageId:'m1',answerHash:'a'.repeat(64),state:'partial',answerSubmittedSamples:160,attribution:'known'};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-ledger-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'ledger.json');}
test('restart recovers unfinished as unknown, verified submitted remains device-only metadata',async t=>{
 const file=fixture(t),s=createPlaybackStore(file);s.update([{...base,text:'PRIVATE',pcm:'PRIVATE'}]);await s.flush();
 assert.equal(fs.readFileSync(file,'utf8').includes('PRIVATE'),false);
 const restored=createPlaybackStore(file);assert.equal(restored.context('c').state,'interrupted');assert.equal(restored.context('c').attribution,'unknown');
 s.update([{...base,state:'submitted'}]);await s.flush();assert.equal(createPlaybackStore(file).context('c').state,'submitted');
 const copy=s.context('c');copy.state='pending';assert.equal(s.context('c').state,'submitted');
});
test('restarted generation cannot overwrite a prior message by matching numeric turn',async t=>{
 const file=fixture(t),s=createPlaybackStore(file);s.update([{...base,state:'submitted'}]);await s.flush();
 const next=createPlaybackStore(file);next.update([{...base,assistantMessageId:'m2',state:'pending',answerSubmittedSamples:0,generation:1,turn:1}]);await next.flush();
 assert.equal(createPlaybackStore(file).context('c').assistantMessageId,'m2');assert.equal(createPlaybackStore(file).context('c').attribution,'unknown');
});
test('bounded schema, malformed file and invalid records fail conservatively',async t=>{
 const file=fixture(t);fs.writeFileSync(file,'{broken');assert.equal(createPlaybackStore(file).context('c'),null);
 const s=createPlaybackStore(file);s.update(Array.from({length:80},(_,i)=>({...base,conversationId:'c'+i})));s.update([{...base,answerSubmittedSamples:Infinity}]);await s.flush();
 assert.equal(JSON.parse(fs.readFileSync(file)).records.length,64);assert.equal(s.context('c0'),null);assert.equal(s.context('c'),null);
 fs.writeFileSync(file,JSON.stringify({version:9,records:[base]}));assert.equal(createPlaybackStore(file).context('c'),null);
});
test('serialized writes retain latest state and IO failure does not throw',async t=>{
 const file=fixture(t),s=createPlaybackStore(file);s.update([base]);const first=s.flush();s.update([{...base,state:'submitted'}]);await s.flush();await first;
 assert.equal(createPlaybackStore(file).context('c').state,'submitted');
 const bad=createPlaybackStore(path.join(file,'nested'));bad.update([base]);await bad.flush();assert.equal(bad.status().failed,true);
});
