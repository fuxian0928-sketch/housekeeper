const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {NativePlayback}=require('../../electron/native-playback.cjs');
const key={generation:1,audioGeneration:1,turn:1};
class Worker extends EventEmitter{constructor(){super();this.audio=[]}playback(packet){if(packet.type==='playback-audio')this.audio.push(Buffer.from(packet.pcm));if(packet.type==='playback-end')queueMicrotask(()=>this.emit('event',{...key,type:'playback-submitted',renderedFrames:this.audio.reduce((n,b)=>n+b.length/320,0)}));return true}}
function pcm(){const b=Buffer.alloc(320);b.writeInt16LE(32767,0);b.writeInt16LE(-32768,2);b.writeInt16LE(1000,4);return b}
test('whole and streamed playback apply volume without mutating source samples',async()=>{
 for(const streaming of [false,true]){const worker=new Worker(),source=pcm(),saved=Buffer.from(source),player=new NativePlayback(worker,{readVolume:()=>50});
 if(streaming){async function* chunks(){yield source.subarray(0,1);yield source.subarray(1)}await player.playStream(key,chunks(),new AbortController().signal)}else await player.play(key,source,new AbortController().signal);
 assert.deepEqual([0,2,4].map(i=>worker.audio[0].readInt16LE(i)),[16384,-16384,500]);assert.deepEqual(source,saved);
 }
});
test('zero mutes and each playback freezes volume until the next playback',async()=>{
 const worker=new Worker();let volume=50;const player=new NativePlayback(worker,{readVolume:()=>volume});
 async function* chunks(){yield pcm();volume=0;yield pcm()}
 await player.playStream(key,chunks(),new AbortController().signal);assert.equal(worker.audio[0].readInt16LE(4),500);assert.equal(worker.audio[1].readInt16LE(4),500);
 worker.audio=[];await player.play(key,pcm(),new AbortController().signal);assert.ok(worker.audio[0].every(b=>b===0));
});
test('out-of-range volume clamps while invalid saved value uses default',async()=>{
 for(const [volume,expected] of [[-2,0],[150,1000],[NaN,1000]]){const worker=new Worker();await new NativePlayback(worker,{readVolume:()=>volume}).play(key,pcm(),new AbortController().signal);assert.equal(worker.audio[0].readInt16LE(4),expected)}
});
