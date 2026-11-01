const test=require('node:test'),assert=require('node:assert/strict');
const {setTimeout:delay}=require('node:timers/promises');
const {bufferPcmStart,localSpeechStartPolicy}=require('../../electron/pcm-start-buffer.cjs');
const signal=()=>new AbortController().signal;

test('initial reservoir preserves PCM order and starts before the rest of a long answer exists',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let ready;
 async function* source(){for(let i=1;i<=3;i++)yield Buffer.alloc(6400,i);await gate;yield Buffer.alloc(3200,4);}
 const iterator=bufferPcmStart(source(),{signal:signal(),onReady:value=>{ready=value;}})[Symbol.asyncIterator]();
 assert.equal((await iterator.next()).value[0],1);assert.equal(ready.bufferedMs,600);assert.ok(ready.waitMs<100);assert.equal(ready.sourceEnded,false);
 assert.equal((await iterator.next()).value[0],2);assert.equal((await iterator.next()).value[0],3);release();
 assert.equal((await iterator.next()).value[0],4);assert.equal((await iterator.next()).done,true);
});

test('completed short utterances do not wait for the target duration or a startup timer',async()=>{
 const pcm=Buffer.alloc(640,5);let ready;
 async function* source(){yield pcm;}
 const started=performance.now(),chunks=[];
 for await(const part of bufferPcmStart(source(),{signal:signal(),onReady:value=>{ready=value;}}))chunks.push(part);
 assert.ok(performance.now()-started<80);assert.equal(ready.sourceEnded,true);assert.equal(ready.bufferedMs,20);assert.deepEqual(Buffer.concat(chunks),pcm);
});

test('a slow producer has a bounded startup wait and one outstanding read, without dropping late PCM',async()=>{
 let provide,nextCalls=0,ready;const source={ [Symbol.asyncIterator](){return this;},next(){nextCalls++;if(nextCalls===1)return Promise.resolve({value:Buffer.alloc(3200,1),done:false});if(nextCalls===2)return new Promise(resolve=>{provide=resolve;});return Promise.resolve({done:true});},return(){return Promise.resolve({done:true});} };
 const iterator=bufferPcmStart(source,{signal:signal(),maxWaitMs:35,onReady:value=>{ready=value;}})[Symbol.asyncIterator]();
 assert.equal((await iterator.next()).value[0],1);assert.ok(ready.waitMs>=25&&ready.waitMs<150);assert.equal(nextCalls,2);
 const second=iterator.next();await delay(5);assert.equal(nextCalls,2);provide({value:Buffer.alloc(3200,2),done:false});assert.equal((await second).value[0],2);assert.equal((await iterator.next()).done,true);
});

test('cancellation during initial fill releases buffers without waiting for a stalled producer',async()=>{
 const controller=new AbortController();let returned=false,read;
 const source={ [Symbol.asyncIterator](){return this;},next(){read?.();return new Promise(()=>{});},return(){returned=true;return new Promise(()=>{});} };
 const started=new Promise(resolve=>{read=resolve;});
 const iterator=bufferPcmStart(source,{signal:controller.signal})[Symbol.asyncIterator](),pending=iterator.next();await started;controller.abort();
 await assert.rejects(pending);assert.equal(returned,true);
});

test('malformed PCM fails instead of padding or stretching sound to hide a producer fault',async()=>{
 async function* source(){yield Buffer.alloc(3);}
 await assert.rejects(async()=>{for await(const _ of bufferPcmStart(source(),{signal:signal()})){}},/INVALID_START_PCM/);
});

test('long replies reserve more audio without increasing short-reply startup budgets',()=>{
 assert.deepEqual(localSpeechStartPolicy(10),{targetMs:600,maxWaitMs:700});
 assert.equal(localSpeechStartPolicy(85).targetMs,2400);
 assert.ok(localSpeechStartPolicy(85).maxWaitMs<=3200);
 assert.equal(localSpeechStartPolicy(3000).targetMs,2400);
});

test('production-aware startup avoids maximal waiting for fast long speech but keeps slow supply protected',()=>{
 assert.equal(localSpeechStartPolicy(120,{bufferedMs:1200,firstChunkMs:200,waitMs:650}).targetMs,600);
 assert.equal(localSpeechStartPolicy(120,{bufferedMs:1200,firstChunkMs:200,waitMs:1200}).targetMs,2400);
 assert.equal(localSpeechStartPolicy(10,{bufferedMs:800,firstChunkMs:200,waitMs:700}).targetMs,600);
 assert.equal(localSpeechStartPolicy(120,{bufferedMs:200,firstChunkMs:200,waitMs:0}).targetMs,2400);
});

test('initial fill follows growing answer length while retaining a fixed memory bound',async()=>{
 let characters=10,ready;
 async function* source(){yield Buffer.alloc(6400,1);characters=85;for(let index=0;index<11;index++)yield Buffer.alloc(6400,2);yield Buffer.alloc(3200,3);}
 const iterator=bufferPcmStart(source(),{signal:signal(),targetMs:()=>localSpeechStartPolicy(characters).targetMs,maxWaitMs:()=>localSpeechStartPolicy(characters).maxWaitMs,onReady:value=>{ready=value;}})[Symbol.asyncIterator]();
 assert.equal((await iterator.next()).value[0],1);assert.equal(ready.bufferedMs,2400);assert.equal(ready.sourceEnded,false);await iterator.return();
});

test('a growing reply can extend its startup budget without duplicating the pending read',async()=>{
 let budget=20,ready,reads=0;
 async function* source(){reads++;yield Buffer.alloc(6400,1);setTimeout(()=>{budget=120;},5);await delay(50);reads++;yield Buffer.alloc(6400,2);reads++;yield Buffer.alloc(6400,3);}
 const chunks=[];for await(const pcm of bufferPcmStart(source(),{signal:signal(),maxWaitMs:()=>budget,onReady:value=>{ready=value;}}))chunks.push(pcm);
 assert.ok(ready.waitMs>=40);assert.equal(ready.bufferedMs,600);assert.equal(reads,3);assert.deepEqual(chunks.map(pcm=>pcm[0]),[1,2,3]);
});
