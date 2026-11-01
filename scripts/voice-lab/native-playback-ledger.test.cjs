const test=require('node:test'),assert=require('node:assert/strict');
const {NativePlaybackLedger}=require('../../electron/native-playback-ledger.cjs');
const key={generation:1,audioGeneration:1,turn:1};

test('a long streamed answer retains device-submission attribution beyond thirty seconds',()=>{
 const ledger=new NativePlaybackLedger();
 ledger.observe({...key,type:'turn-start'});
 for(let i=0;i<160;i++)assert.equal(ledger.offer(key,'answer',6400),true);
 const frames=160*6400/320;
 assert.equal(ledger.observe({...key,type:'playback-submitted',renderedFrames:frames}),true);
 assert.equal(ledger.complete(key,frames),true);
 assert.equal(ledger.snapshot().at(-1).attribution,'known');
});
test('progress-only playback does not count as answer and padding is not attributed',()=>{
 const l=new NativePlaybackLedger();l.observe({...key,type:'turn-start'});
 assert.equal(l.offer(key,'progress',320),true);assert.equal(l.offer(key,'answer',480),true);
 l.observe({...key,type:'playback-progress',renderedFrames:1});
 assert.equal(l.snapshot()[0].answerSubmittedSamples,0);assert.equal(l.snapshot()[0].progressSubmittedSamples,160);
 l.observe({...key,type:'playback-submitted',renderedFrames:3});
 assert.equal(l.snapshot()[0].answerSubmittedSamples,240);assert.equal(l.snapshot()[0].progressSubmittedSamples,160);
 assert.equal(l.snapshot()[0].submittedSamples,480);assert.equal(l.snapshot()[0].attribution,'known');
 assert.equal(l.snapshot()[0].state,'partial');assert.equal(l.complete(key,3),true);
 assert.equal(l.offer(key,'answer',320),false);
});
test('foreign or malformed packets cannot move attribution offsets',()=>{
 const l=new NativePlaybackLedger();l.observe({...key,type:'turn-start'});
 assert.equal(l.offer({...key,turn:2},'answer',320),false);assert.equal(l.offer(key,'secret',320),false);assert.equal(l.offer(key,'answer',Infinity),false);
 assert.equal(l.snapshot()[0].offeredBytes,0);
});
test('submitted audio does not imply text alignment or physical audibility',()=>{
 const ledger=new NativePlaybackLedger();ledger.observe({...key,type:'turn-start'});
 ledger.offer(key,'answer',6400);ledger.offer(key,'answer',4800);
 ledger.observe({...key,type:'playback-progress',renderedFrames:25});
 assert.equal(ledger.snapshot()[0].submittedSamples,4000);
 ledger.observe({...key,type:'playback-submitted',renderedFrames:35});
 assert.equal(ledger.snapshot()[0].state,'partial');assert.equal(ledger.complete(key,35),true);
 assert.equal(ledger.snapshot()[0].state,'submitted');assert.equal(ledger.snapshot()[0].textAlignment,'unknown');assert.equal(ledger.snapshot()[0].audibility,'unverified');
});
test('interruption freezes conservative cursor and late results cannot rewrite it',()=>{
 const l=new NativePlaybackLedger();l.observe({...key,type:'turn-start'});l.offer(key,'answer',6400);l.offer(key,'answer',1600);l.observe({...key,type:'playback-progress',renderedFrames:25});
 l.observe({...key,type:'turn-cancelled'});assert.equal(l.observe({...key,type:'playback-submitted',renderedFrames:100}),false);
 l.observe({...key,turn:2,type:'turn-start'});assert.equal(l.observe({...key,type:'playback-progress',renderedFrames:200}),false);
 assert.equal(l.snapshot()[0].submittedSamples,4000);assert.equal(l.snapshot()[0].state,'interrupted');
});
test('history stays bounded and stale device close cannot freeze a replacement',()=>{
 const l=new NativePlaybackLedger();for(let turn=1;turn<=100;turn++)l.observe({...key,generation:2,turn,type:'turn-start'});
 l.freeze('device-closed',1);assert.equal(l.snapshot().length,64);assert.equal(l.snapshot().at(-1).state,'pending');
 l.freeze('device-closed',2);assert.equal(l.snapshot().at(-1).state,'device-closed');
});

test('impossible receipt cannot claim answer submission or verified completion',()=>{
 const l=new NativePlaybackLedger();l.observe({...key,type:'turn-start'});l.offer(key,'answer',320);
 assert.equal(l.observe({...key,type:'playback-submitted',renderedFrames:100}),false);
 assert.equal(l.snapshot()[0].answerSubmittedSamples,0);assert.equal(l.complete(key,100),false);
 l.observe({...key,type:'playback-submitted',renderedFrames:1});assert.equal(l.complete(key,1),false);
 assert.equal(l.snapshot()[0].attribution,'unknown');
});
test('raw early completion followed by more offered audio cannot finalize old size',()=>{
 const l=new NativePlaybackLedger();l.observe({...key,type:'turn-start'});l.offer(key,'answer',320);
 l.observe({...key,type:'playback-submitted',renderedFrames:1});l.offer(key,'answer',320);
 assert.equal(l.complete(key,1),false);l.freeze('device-error');assert.equal(l.complete(key,2),false);
});

test('binding requires stable identity and cannot overwrite a different message',()=>{
 const l=new NativePlaybackLedger();l.observe({...key,type:'turn-start'});const hash='a'.repeat(64);
 assert.equal(l.bind(key,'c',hash),false);assert.equal(l.context('c'),null);
 assert.equal(l.bind(key,'c',hash,'m1'),true);assert.equal(l.context('c').assistantMessageId,'m1');
 assert.equal(l.bind(key,'c',hash,'m2'),false);assert.equal(l.bind(key,'other',hash,'m1'),false);
 assert.equal(l.context('other'),null);assert.equal(l.context('c').assistantMessageId,'m1');
 const next={...key,turn:2};l.observe({...next,type:'turn-start'});assert.equal(l.bind(next,'c',hash,'m2'),true);
 assert.equal(l.context('c').assistantMessageId,'m2');
});
