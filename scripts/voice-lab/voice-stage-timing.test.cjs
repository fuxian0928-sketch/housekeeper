const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createVoiceStageTiming}=require('../../electron/voice-stage-timing.cjs');

test('cancellation reasons distinguish deadlines from real interruptions without copying arbitrary strings',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-cancel-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const timing=createVoiceStageTiming(path.join(dir,'timings.json')),key={generation:1,audioGeneration:1,turn:1};
 timing.mark({...key,reason:'interruption'},'turn-start');timing.mark({...key,reason:'interrupted'},'turn-cancelled');
 assert.equal(timing.snapshot()[0].cancelReason,'interrupted');assert.equal(timing.snapshot()[0].trigger,'interruption');
 timing.mark({...key,turn:2},'turn-start');timing.mark({...key,turn:2,reason:'PRIVATE'},'turn-cancelled');
 timing.mark({...key,turn:2,code:'VOICE_TURN_TIMEOUT'},'turn-failed');
 assert.equal(timing.snapshot()[1].failureCode,'VOICE_TURN_TIMEOUT');
 await timing.flush();assert.ok(!fs.readFileSync(path.join(dir,'timings.json'),'utf8').includes('PRIVATE'));
});

test('TTS and device diagnostics separate raw, reservoir, underruns and pauses without persisting arbitrary data',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'speech-metrics-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=0;
 const timing=createVoiceStageTiming(path.join(dir,'timings.json'),()=>now),key={generation:1,audioGeneration:1,turn:1};
 timing.mark(key,'turn-start');now=100;timing.record(key,'tts-first-raw-pcm');now=700;timing.record(key,'tts-buffer-ready',{bufferedMs:600,bufferWaitMs:600,text:'PRIVATE'});
 now=1200;timing.record(key,'playback-health',{underrunMs:200,underrunCount:1,pausedMs:0,queuedMs:100,deviceOutputUnderflows:2,headOutputUnderflows:1,headMaxGapMs:49.6,pcm:123,extra:12});
 const copy=timing.snapshot();copy[0].metrics.underrunMs=999;
 assert.equal(timing.snapshot()[0].marks['tts-first-raw-pcm'],100);assert.equal(timing.snapshot()[0].metrics.underrunMs,200);assert.equal(timing.snapshot()[0].metrics.headOutputUnderflows,1);assert.equal(timing.snapshot()[0].metrics.headMaxGapMs,50);
 await timing.flush();const stored=fs.readFileSync(path.join(dir,'timings.json'),'utf8');assert.ok(!stored.includes('PRIVATE'));assert.ok(!stored.includes('extra'));assert.equal(Object.hasOwn(JSON.parse(stored).turns[0].metrics,'pcm'),false);
 await timing.clear();timing.record(key,'tts-production',{audioMs:5000});assert.deepEqual(timing.snapshot(),[]);
});
test('timings are bounded, monotonic, keyed, immutable and contain no transcript',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage-timing-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=100;
 const file=path.join(dir,'timings.json'),timing=createVoiceStageTiming(file,()=>now),key={generation:1,audioGeneration:1,turn:1,reason:'wake',text:'PRIVATE',pcm:'PRIVATE'};
 timing.mark(key,'asr-final');assert.equal(timing.snapshot().length,0);timing.mark(key,'turn-start');now=250;timing.mark(key,'turn-end');now=500;timing.mark(key,'asr-final');timing.mark(key,'PRIVATE');now=900;timing.mark(key,'asr-final');
 assert.equal(timing.snapshot()[0].marks['asr-final'],400);assert.equal(timing.snapshot()[0].trigger,'wake');const copy=timing.snapshot();copy[0].marks['asr-final']=0;assert.equal(timing.snapshot()[0].marks['asr-final'],400);
 await timing.flush();assert.ok(!fs.readFileSync(file,'utf8').includes('PRIVATE'));
 for(let turn=2;turn<=70;turn++)timing.mark({...key,turn},'turn-start');assert.equal(timing.snapshot().length,64);timing.mark(key,'playback-complete');assert.equal(timing.snapshot().length,64);await timing.flush();
});

test('clear replaces persisted timings after a pending write and late marks cannot restore them',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage-timing-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'timings.json'),timing=createVoiceStageTiming(file),key={generation:1,audioGeneration:1,turn:1};
 timing.mark(key,'turn-start');const pending=timing.flush();await timing.clear();await pending;
 assert.deepEqual(timing.snapshot(),[]);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).turns,[]);
 timing.mark(key,'asr-final');timing.mark(key,'playback-complete');await timing.flush();
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).turns,[]);
 timing.mark({...key,turn:2},'turn-start');await timing.flush();assert.equal(timing.snapshot().length,1);
});

test('clear reports persistence failure instead of claiming disk removal',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage-timing-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const blocker=path.join(dir,'blocker');fs.writeFileSync(blocker,'untouched');
 const timing=createVoiceStageTiming(path.join(blocker,'timings.json'));
 await assert.rejects(timing.clear(),/未能清除/);assert.equal(fs.readFileSync(blocker,'utf8'),'untouched');
});
