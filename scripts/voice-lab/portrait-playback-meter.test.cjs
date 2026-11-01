const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createPortraitPlaybackMeter}=require('../../electron/portrait-playback-meter.cjs');
const key={generation:1,audioGeneration:2,turn:3};
const pcm=(value,frames=10)=>{const buffer=Buffer.alloc(frames*320);for(let i=0;i<buffer.length;i+=2)buffer.writeInt16LE(value,i);return buffer;};
test('mouth envelope only advances with matching device receipts, not queued synthesis',()=>{
 const worker=new EventEmitter(),values=[],meter=createPortraitPlaybackMeter(worker,key,v=>values.push(v));
 meter.offer(pcm(8192));assert.deepEqual(values,[]);
 worker.emit('event',{...key,type:'playback-progress',turn:4,renderedFrames:10});assert.deepEqual(values,[]);
 worker.emit('event',{...key,type:'playback-progress',renderedFrames:11});assert.deepEqual(values,[]);
 worker.emit('event',{...key,type:'playback-progress',renderedFrames:10});assert.equal(values.at(-1),.25);
 meter.offer(pcm(0));worker.emit('event',{...key,type:'playback-progress',renderedFrames:20});assert.equal(values.at(-1),0);
 worker.emit('event',{...key,type:'playback-progress',renderedFrames:10});assert.equal(values.length,2);
 meter.dispose();assert.equal(values.at(-1),0);assert.equal(worker.listenerCount('event'),0);
});
test('pause and cancellation close the mouth; visual observer failures cannot break audio',()=>{
 const worker=new EventEmitter(),values=[],meter=createPortraitPlaybackMeter(worker,key,v=>values.push(v));
 meter.offer(pcm(16384));worker.emit('event',{...key,type:'playback-progress',renderedFrames:10});assert.equal(values.at(-1),.5);
 worker.emit('event',{...key,type:'playback-paused'});assert.equal(values.at(-1),0);
 worker.emit('event',{...key,type:'turn-cancelled'});assert.equal(values.at(-1),0);meter.dispose();
 const faulty=createPortraitPlaybackMeter(worker,key,()=>{throw Error('detached view')});faulty.offer(pcm(1));
 assert.doesNotThrow(()=>worker.emit('event',{...key,type:'playback-progress',renderedFrames:10}));faulty.dispose();
});
