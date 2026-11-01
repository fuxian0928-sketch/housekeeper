const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');const path=require('node:path');
const {createLocalSpeechProvider}=require('../../electron/local-speech-provider.cjs');

test('raw PCM and buffer readiness are separate measurements; no provider text enters diagnostics',async()=>{
 const metrics=[],f=fixture((event,emit)=>{if(event.type==='tts-text')emit({type:'pcm',id:event.id,pcm:Buffer.alloc(640,1).toString('base64')});if(event.type==='tts-finish')emit({type:'done',id:event.id,synthesisMs:20,creditWaitMs:0,segments:1,trimmedMs:0,text:'PRIVATE'});});
 try{await f.provider.ready;const tts=f.provider.connectTts({signal:new AbortController().signal,onMetric:m=>metrics.push(m)});await tts.ready;tts.append('测试');
 assert.deepEqual(metrics.map(m=>m.stage),['tts-first-raw-pcm','tts-first-voiced-pcm']);tts.finish();for await(const _pcm of tts.audio){}
 assert.deepEqual(metrics.map(m=>m.stage),['tts-first-raw-pcm','tts-first-voiced-pcm','tts-production','tts-buffer-ready']);
 assert.equal(metrics.at(-1).values.bufferedMs,20);assert.ok(!JSON.stringify(metrics).includes('PRIVATE'));
 }finally{await f.provider.close();}
});
function fixture(handler){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
 const sent=[];const emit=event=>child.stdout.write(JSON.stringify(event)+'\n');
 child.stdin.on('data',data=>{for(const line of data.toString().trim().split('\n')){const event=JSON.parse(line);sent.push(event);if(event.type.endsWith('-open'))emit({type:'opened',id:event.id});handler?.(event,emit);}});
 child.stdin.on('finish',()=>child.emit('exit',0));child.kill=()=>child.emit('exit',0);
 const provider=createLocalSpeechProvider({python:path.resolve('python.exe'),workerRoot:process.cwd(),modelRoot:path.resolve('models'),spawnProcess:()=>child,startupMs:1000});
 queueMicrotask(()=>emit({type:'ready',protocol:1,sampleRate:16000,channels:1,voice:'xiwei-sweet-soft'}));
 return {provider,sent,emit,child};
}
test('local ASR works without a key, cloud URL or network transport',async()=>{
 const f=fixture((event,emit)=>{if(event.type==='asr-finish')emit({type:'final',id:event.id,text:'希微，打开本周周报',audioBytes:320});});
 try{await f.provider.ready;const asr=f.provider.connectAsr({signal:new AbortController().signal});await asr.ready;assert.equal(asr.append(Buffer.alloc(320)),true);assert.deepEqual(await asr.finish(),{text:'希微，打开本周周报',final:true,audioBytes:320});assert.deepEqual(f.sent.filter(e=>e.type.startsWith('asr')).map(e=>e.type),['asr-open','asr-pcm','asr-finish']);}
 finally{await f.provider.close();}
});
test('cancelled ASR ignores delayed old finals and rejects its result',async()=>{
 const f=fixture();try{await f.provider.ready;const controller=new AbortController();const asr=f.provider.connectAsr({signal:controller.signal});await asr.ready;const id=f.sent[0].id;controller.abort();await assert.rejects(asr.result,/ASR_CANCELLED/);f.emit({type:'final',id,text:'迟到内容',audioBytes:0});assert.equal(asr.append(Buffer.alloc(320)),false);}
 finally{await f.provider.close();}
});
test('streaming PCM is consumed before final synthesis and returns bounded credits',async()=>{
 const f=fixture((event,emit)=>{if(event.type==='tts-text')emit({type:'pcm',id:event.id,pcm:Buffer.alloc(640).toString('base64')});if(event.type==='tts-finish')emit({type:'done',id:event.id});});
 try{await f.provider.ready;const tts=f.provider.connectTts({signal:new AbortController().signal});await tts.ready;tts.append('主人，我在。');const iterator=tts.audio[Symbol.asyncIterator]();assert.equal((await iterator.next()).value.length,640);assert.equal(tts.finish(),true);assert.equal((await iterator.next()).done,true);assert.equal(f.sent.filter(e=>e.type==='credit').length,1);}
 finally{await f.provider.close();}
});
test('cancellation discards buffered TTS and prevents replay after done',async()=>{
 const f=fixture((event,emit)=>{if(event.type==='tts-text')emit({type:'pcm',id:event.id,pcm:Buffer.alloc(640).toString('base64')});});
 try{await f.provider.ready;const controller=new AbortController();const tts=f.provider.connectTts({signal:controller.signal});await tts.ready;tts.append('不应播放');controller.abort();await assert.rejects(tts.audio[Symbol.asyncIterator]().next());assert.equal(tts.append('迟到文字'),false);}
 finally{await f.provider.close();}
});
test('malformed output and process exit reject current work',async()=>{
 const f=fixture();try{await f.provider.ready;const tts=f.provider.connectTts({signal:new AbortController().signal});await tts.ready;tts.append('测试');f.emit({type:'pcm',id:f.sent.find(e=>e.type==='tts-open').id,pcm:'not-base64!'});await assert.rejects(tts.audio[Symbol.asyncIterator]().next(),/INVALID_PCM/);}
 finally{await f.provider.close();}
});
test('an exited worker fails future requests without falling back to cloud',async()=>{
 const f=fixture();await f.provider.ready;f.child.emit('exit',1);const asr=f.provider.connectAsr({signal:new AbortController().signal});await assert.rejects(asr.ready,/ASR_LOCAL_FAILED/);assert.equal(f.provider.status().ready,false);await f.provider.close();
});

test('deep thinking does not consume synthesis budget or delay the first short sentence',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const f=fixture((event,emit)=>{if(event.type==='tts-text')emit({type:'pcm',id:event.id,pcm:Buffer.alloc(640).toString('base64')});if(event.type==='tts-finish')emit({type:'done',id:event.id});});
 try{
  await f.provider.ready;const tts=f.provider.connectTts({signal:new AbortController().signal});await tts.ready;
  context.mock.timers.tick(240001);
  assert.equal(tts.append('主人，我在。'),true);
  assert.equal(tts.finish(),true);
  const iterator=tts.audio[Symbol.asyncIterator]();assert.equal((await iterator.next()).value.length,640);
  assert.equal((await iterator.next()).done,true);
 }finally{await f.provider.close();context.mock.timers.reset();}
});

test('a completed short clip bypasses the startup reservoir and preserves every sample',async()=>{
 const pcm=Buffer.alloc(640,11),f=fixture((event,emit)=>{if(event.type==='tts-text')emit({type:'pcm',id:event.id,pcm:pcm.toString('base64')});if(event.type==='tts-finish')emit({type:'done',id:event.id});});
 try{await f.provider.ready;const tts=f.provider.connectTts({signal:new AbortController().signal});await tts.ready;tts.append('好。');tts.finish();const began=performance.now(),chunks=[];for await(const part of tts.audio)chunks.push(part);assert.ok(performance.now()-began<100);assert.deepEqual(Buffer.concat(chunks),pcm);}
 finally{await f.provider.close();}
});

test('interrupting while the initial audio reservoir fills cancels the old TTS immediately',async()=>{
 const f=fixture((event,emit)=>{if(event.type==='tts-text')emit({type:'pcm',id:event.id,pcm:Buffer.alloc(640).toString('base64')});});
 try{await f.provider.ready;const controller=new AbortController(),tts=f.provider.connectTts({signal:controller.signal});await tts.ready;tts.append('旧回答');const pending=tts.audio[Symbol.asyncIterator]().next();await new Promise(resolve=>setTimeout(resolve,10));controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.ok(f.sent.some(event=>event.type==='cancel'));assert.equal(tts.append('迟到文字'),false);}
 finally{await f.provider.close();}
});
