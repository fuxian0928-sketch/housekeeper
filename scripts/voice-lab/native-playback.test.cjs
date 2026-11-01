const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {Writable}=require('node:stream');
const {setTimeout:delay}=require('node:timers/promises');
const {NativePlayback}=require('../../electron/native-playback.cjs');
const {VoiceWorkerSupervisor}=require('../../electron/voice-worker-supervisor.cjs');
const key={generation:1,audioGeneration:2,turn:3};
class Worker extends EventEmitter{
  packets=[];
  playback(packet){this.packets.push({...packet,...(packet.pcm?{pcm:Buffer.from(packet.pcm)}:{})});return true;}
  receipt(frames){this.emit('event',{...key,type:'playback-submitted',renderedFrames:frames});}
}

test('slow first answer beyond five seconds still reaches native playback', {timeout:8000}, async()=>{
 const worker=new Worker(),player=new NativePlayback(worker);
 const original=worker.playback.bind(worker);
 worker.playback=packet=>{const result=original(packet);if(packet.type==='playback-end')queueMicrotask(()=>worker.receipt(1));return result;};
 async function* source(){await delay(5100);yield Buffer.alloc(320,7);}
 const result=await player.playStream(key,source(),new AbortController().signal);
 assert.equal(result.renderedFrames,1);assert.equal(worker.packets.filter(p=>p.type==='playback-audio').length,1);
 assert.equal(player.active,null);
});

test('source hang still releases ownership within configured budget',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker,{sourceTimeoutMs:30,playbackTimeoutMs:200});
 const source={ [Symbol.asyncIterator](){return this;},next(){return new Promise(()=>{});},return(){return new Promise(()=>{});} };
 await assert.rejects(player.playStream(key,source,new AbortController().signal),/SOURCE_TIMEOUT/);
 assert.equal(player.active,null);assert.equal(worker.packets.at(-1).type,'playback-cancel');
});

test('continuous optional packets cannot reset absolute playback deadline',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker,{sourceTimeoutMs:80,playbackTimeoutMs:100,maxDurationMs:100});
 let returned=false;
 async function* source(){try{while(true){await delay(5);yield Buffer.alloc(320);}}finally{returned=true;}}
 await assert.rejects(player.playStream(key,source(),new AbortController().signal),/TURN_LIMIT/);
 await delay(15);assert.equal(player.active,null);assert.equal(returned,true);
 assert.ok(worker.packets.some(p=>p.type==='playback-audio'));
});
test('ongoing speech extends the inactivity deadline without delaying first playback',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker,{sourceTimeoutMs:60,playbackTimeoutMs:80,maxDurationMs:500});
 const original=worker.playback.bind(worker);
 worker.playback=packet=>{const result=original(packet);if(packet.type==='playback-end')queueMicrotask(()=>worker.receipt(24));return result;};
 async function* source(){for(let i=0;i<24;i++){await delay(12);yield Buffer.alloc(320,i);}}
 const started=performance.now();
 const result=await player.playStream(key,source(),new AbortController().signal);
 assert.equal(result.renderedFrames,24);
 assert.ok(performance.now()-started>200);
 assert.equal(worker.packets.filter(p=>p.type==='playback-audio').length,24);
});
test('PCM packets are paced, padded and wait for matching device receipt',async()=>{
 const worker=new Worker(), player=new NativePlayback(worker),controller=new AbortController();
 const pcm=Buffer.alloc(3500,3);let settled=false;
 const done=player.play(key,pcm,controller.signal).then(value=>{settled=true;return value;});
 assert.deepEqual(worker.packets.map(p=>p.type),['playback-begin','playback-audio']);
 await delay(130);assert.equal(settled,false);
 assert.deepEqual(worker.packets.map(p=>p.type),['playback-begin','playback-audio','playback-audio','playback-end']);
 assert.equal(worker.packets[2].pcm.length,320);assert.equal(worker.packets[2].pcm[319],0);
 worker.emit('event',{...key,turn:2,type:'playback-submitted',renderedFrames:11});assert.equal(settled,false);
 worker.receipt(11);assert.equal((await done).renderedFrames,11);
 assert.equal(worker.packets.at(-1).type,'playback-cancel');assert.equal(worker.listenerCount('event'),0);
 assert.equal(pcm[0],3);
});
test('cancel and worker exit stop sending and discard late completion',async()=>{
 for(const trigger of ['abort','exit','new-turn']){
 const worker=new Worker(),player=new NativePlayback(worker),controller=new AbortController();
 const done=player.play(key,Buffer.alloc(6400),controller.signal);
 if(trigger==='abort')controller.abort();
 else if(trigger==='exit')worker.emit('closed',{generation:1});
 else worker.emit('event',{...key,turn:4,type:'turn-start'});
 await assert.rejects(done);worker.receipt(20);await delay(120);
 assert.equal(worker.packets.filter(p=>p.type==='playback-audio').length,1);
 assert.equal(worker.packets.at(-1).type,'playback-cancel');assert.equal(player.active,null);
 }
});
test('short or conflicting receipt fails instead of resuming listening',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker);
 const done=player.play(key,Buffer.alloc(320),new AbortController().signal);
 worker.receipt(2);await assert.rejects(done);
 assert.equal(worker.listenerCount('event'),0);
});
test('already aborted input never reaches native process',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker),controller=new AbortController();controller.abort();
 await assert.rejects(player.play(key,Buffer.alloc(320),controller.signal));assert.equal(worker.packets.length,0);
});

test('stream plays before synthesis finishes and joins odd packet boundaries without changing PCM',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker),controller=new AbortController();
 let finishSource;
 const gate=new Promise(resolve=>{finishSource=resolve;});
 const input=Buffer.alloc(1000);for(let i=0;i<input.length;i++)input[i]=i%255;
 async function* source(){yield input.subarray(0,321);await gate;yield input.subarray(321);}
 const done=player.playStream(key,source(),controller.signal);
 await delay(20);
 assert.equal(worker.packets.filter(p=>p.type==='playback-audio').length,1);
 assert.equal(worker.packets.some(p=>p.type==='playback-end'),false);
 finishSource();await delay(100);
 const audio=Buffer.concat(worker.packets.filter(p=>p.type==='playback-audio').map(p=>p.pcm));
 assert.deepEqual(audio.subarray(0,input.length),input);
 assert.equal(audio.length,1280);assert.ok(audio.subarray(1000).every(n=>n===0));
 worker.receipt(4);assert.deepEqual(await done,{renderedFrames:4});
 assert.equal(player.active,null);assert.equal(worker.listenerCount('event'),0);
});

test('stream sends audio ahead of device pace while keeping the queue bounded',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker);
 const sent=[];
 const original=worker.playback.bind(worker);
 worker.playback=packet=>{if(packet.type==='playback-audio')sent.push(performance.now());const ok=original(packet);if(packet.type==='playback-end')queueMicrotask(()=>worker.receipt(120));return ok;};
 async function* source(){for(let i=0;i<12;i++)yield Buffer.alloc(3200,i+1);}
 await player.playStream(key,source(),new AbortController().signal);
 assert.equal(sent.length,12);
 assert.ok(sent[1]-sent[0]<70,'the second packet should create playback headroom');
 assert.ok(sent[11]-sent[0]>450,'the full stream must not flood the native queue');
});

test('a 400ms producer stall does not punch silence into an already playing sentence',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker);let until=0,gap=0,maxLead=0,first;
 const started=performance.now(),original=worker.playback.bind(worker);
 worker.playback=packet=>{const ok=original(packet),now=performance.now();
  if(packet.type==='playback-audio'){first??=now;if(until&&now>until)gap+=now-until;until=Math.max(until,now)+packet.pcm.length/32;maxLead=Math.max(maxLead,until-now);}
  if(packet.type==='playback-end')setTimeout(()=>worker.receipt(100),Math.max(0,until-now)+10);
  return ok;
 };
 async function* source(){for(let i=0;i<10;i++){if(i===6)await delay(400);yield Buffer.alloc(3200,i+1);}}
 await player.playStream(key,source(),new AbortController().signal);
 assert.ok(first-started<70,'first audio must be delivered immediately');
 assert.equal(gap,0,'the device must keep receiving continuous samples through the stall');
 assert.ok(maxLead<750,'headroom must remain well below the 2s native queue');
});

test('resuming preserves queued audio headroom instead of refilling it twice',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker);let seenPause;
 const paused=new Promise(resolve=>{seenPause=resolve}),original=worker.playback.bind(worker);let count=0;
 worker.playback=packet=>{const ok=original(packet);if(packet.type==='playback-audio'&&++count===6)queueMicrotask(()=>{worker.emit('event',{...key,type:'playback-paused',pauseId:1,renderedFrames:0});seenPause();});if(packet.type==='playback-end')queueMicrotask(()=>worker.receipt(100));return ok;};
 async function* source(){for(let i=0;i<10;i++)yield Buffer.alloc(3200);}
 const done=player.playStream(key,source(),new AbortController().signal);await paused;
 worker.emit('event',{...key,type:'playback-resumed',pauseId:1,renderedFrames:0});await delay(30);
 assert.equal(count,6,'already queued samples still occupy the headroom after resume');
 await done;
});

test('invalid lead budgets cannot overflow the bounded native queue',()=>{
 for(const leadMs of [-1,1001,NaN,Infinity])assert.throws(()=>new NativePlayback(new Worker(),{leadMs}),/INVALID_LEAD/);
});

test('local speech reservoir covers an 800ms synthesis boundary without changing playback pace',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker,{leadMs:900});let until=0,gap=0,maxLead=0;
 const original=worker.playback.bind(worker);
 worker.playback=packet=>{const ok=original(packet),now=performance.now();
  if(packet.type==='playback-audio'){if(until&&now>until)gap+=now-until;until=Math.max(until,now)+packet.pcm.length/32;maxLead=Math.max(maxLead,until-now);}
  if(packet.type==='playback-end')setTimeout(()=>worker.receipt(160),Math.max(0,until-now)+10);
  return ok;
 };
 async function* source(){for(let i=0;i<16;i++){if(i===11)await delay(800);yield Buffer.alloc(3200,i+1);}}
 const result=await player.playStream(key,source(),new AbortController().signal);
 assert.equal(result.renderedFrames,160);assert.equal(gap,0);assert.ok(maxLead<1200,'local reservoir must stay below native 2s capacity');
 assert.deepEqual(worker.packets.filter(p=>p.type==='playback-audio').map(p=>p.pcm[0]),Array.from({length:16},(_,i)=>i+1));
});

function congestedPipe(){
 const worker=new VoiceWorkerSupervisor({executable:process.execPath,args:[]}),packets=[];
 const stdin=new Writable({write(chunk,_encoding,done){setTimeout(()=>{
   if(chunk[0]===123){const packet=JSON.parse(chunk.toString());packets.push(packet);
    if(packet.type==='playback-end')worker.emit('event',{...key,type:'playback-submitted',renderedFrames:30});}
   done();
 },15);}});
 worker.current={generation:key.generation,ready:true,stopping:false,child:{stdin}};
 stdin.write(Buffer.alloc(21000));
 return {worker,stdin,packets};
}

test('a congested inherited pipe drains without losing PCM or rejecting interruption controls',async()=>{
 const {worker,stdin,packets}=congestedPipe(),player=new NativePlayback(worker);
 assert.equal(worker.resolveInterruption({workerGeneration:1,audioGeneration:2,turn:3,pauseId:1},'resume'),true);
 assert.equal(worker.command({...key,type:'speaking'}),true);
 async function* source(){for(let i=1;i<=3;i++)yield Buffer.alloc(3200,i);}
 try{
  const receipt=await player.playStream(key,source(),new AbortController().signal);
  assert.equal(receipt.renderedFrames,30);
  const audio=packets.filter(p=>p.type==='playback-audio');
  assert.deepEqual(audio.map(p=>p.sequence),[0,1,2]);
  assert.deepEqual(audio.map(p=>Buffer.from(p.pcm,'base64')[0]),[1,2,3]);
  assert.ok(packets.some(p=>p.type==='interruption-resolve'));
 }finally{stdin.destroy();}
});

test('cancellation and worker retirement release a sender waiting for pipe capacity',async()=>{
 for(const action of ['abort','retire']){
  const {worker,stdin,packets}=congestedPipe(),player=new NativePlayback(worker),controller=new AbortController();
  let read=false;
  async function* source(){read=true;yield Buffer.alloc(320);}
  const done=player.playStream(key,source(),controller.signal);
  if(action==='abort')controller.abort();else worker.current=null;
  try{await assert.rejects(done);assert.equal(read,false);assert.equal(player.active,null);assert.equal(worker.listenerCount('event'),0);assert.equal(packets.some(p=>p.type==='playback-audio'),false);}
  finally{stdin.destroy();}
 }
});

test('cancel releases a stalled stream and rejects late producer data',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker),controller=new AbortController();
 let provide;let returned=false;
 const source={ [Symbol.asyncIterator](){return this;},next(){return new Promise(resolve=>{provide=resolve;});},return(){returned=true;return Promise.resolve({done:true});} };
 const done=player.playStream(key,source,controller.signal);await delay(0);controller.abort();
 await assert.rejects(done,/CANCELLED/);assert.equal(returned,true);assert.equal(player.active,null);
 provide({value:Buffer.alloc(320),done:false});await delay(0);
 assert.deepEqual(worker.packets.map(p=>p.type),['playback-begin','playback-cancel']);
});

test('stream rejects malformed or oversized PCM and does not accept early completion',async()=>{
 for(const input of [Buffer.alloc(1),Buffer.alloc(6401),Buffer.alloc(0),'invalid']){
 const worker=new Worker(),player=new NativePlayback(worker);
 async function* source(){yield input;}
 await assert.rejects(player.playStream(key,source(),new AbortController().signal),/INVALID_PCM/);
 assert.equal(worker.packets.at(-1).type,'playback-cancel');assert.equal(player.active,null);
 }
 const worker=new Worker(),player=new NativePlayback(worker);
 async function* source(){yield Buffer.alloc(320);await new Promise(()=>{});}
 const done=player.playStream(key,source(),new AbortController().signal);await delay(0);
 worker.receipt(1);await assert.rejects(done,/INVALID_RECEIPT/);
});

test('real inherited pipes transport bounded PCM and sanitize completion',async()=>{
 const script=`const readline=require('node:readline');let frames=0,sequence=0;
 console.log(JSON.stringify({type:'ready'}));
 readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='stop')process.exit(0);
 if(m.type==='ping')console.log(JSON.stringify({type:'alive'}));
 if(m.type==='playback-begin'){frames=0;sequence=0;}
 if(m.type==='playback-audio'){
 const pcm=Buffer.from(m.pcm,'base64');
 if(m.sequence!==sequence++||pcm.length>6400||pcm.length%320)process.exit(2);
 frames+=pcm.length/320;
 }
 if(m.type==='playback-end'){
 if(m.sequence!==sequence)process.exit(3);
 console.log(JSON.stringify({type:'playback-submitted',generation:m.generation,turn:m.turn,renderedFrames:frames,secret:'not-forwarded'}));
 }});`;
 const worker=new VoiceWorkerSupervisor({executable:process.execPath,args:['-e',script],startupMs:2000,heartbeatMs:100,silenceMs:2000,stopMs:200});
 const events=[];worker.on('event',e=>events.push(e));
 try{
 const started=await worker.start();
 const current={...key,generation:started.generation};
 assert.equal(worker.playback({...current,generation:current.generation-1,type:'playback-begin'}),false);
 assert.equal(worker.playback({...current,type:'playback-audio',sequence:0,pcm:Buffer.alloc(6401)}),false);
 const result=await new NativePlayback(worker).play(current,Buffer.alloc(6500),new AbortController().signal);
 assert.equal(result.renderedFrames,21);
 const receipt=events.find(e=>e.type==='playback-submitted');
 assert.deepEqual(receipt,{type:'playback-submitted',generation:current.generation,audioGeneration:2,turn:3,renderedFrames:21});
 }finally{await worker.stop();}
});

test('native pause stops stream feeding, ignores stale resume and resumes remaining PCM',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker);let paused;
 const pauseSeen=new Promise(resolve=>{paused=resolve});
 const original=worker.playback.bind(worker);let first=true;
 worker.playback=packet=>{const result=original(packet);if(packet.type==='playback-audio'&&first){first=false;queueMicrotask(()=>{worker.emit('event',{...key,type:'playback-paused',pauseId:2,renderedFrames:1});paused()})}return result};
 async function* source(){yield Buffer.alloc(320,1);yield Buffer.alloc(320,2);yield Buffer.alloc(320,3)}
 const done=player.playStream(key,source(),new AbortController().signal);await pauseSeen;await delay(30);
 assert.equal(worker.packets.filter(p=>p.type==='playback-audio').length,1);
 worker.emit('event',{...key,type:'playback-resumed',pauseId:1,renderedFrames:1});await delay(20);
 assert.equal(worker.packets.filter(p=>p.type==='playback-audio').length,1);
 assert.equal(player.resume({...key,turn:99},2),false);assert.equal(player.resume(key,2),true);
 worker.emit('event',{...key,type:'playback-resumed',pauseId:2,renderedFrames:1});await delay(60);
 worker.receipt(3);await done;
 assert.deepEqual(worker.packets.filter(p=>p.type==='playback-audio').map(p=>p.pcm[0]),[1,2,3]);
 assert.equal(player.pause(key,3),false);
});

test('abort while paused releases the stream without waiting for resume',async()=>{
 const worker=new Worker(),player=new NativePlayback(worker),controller=new AbortController();
 let first;const ready=new Promise(resolve=>{first=resolve});
 async function* source(){yield Buffer.alloc(320);first();yield Buffer.alloc(320)}
 const done=player.playStream(key,source(),controller.signal);await ready;
 worker.emit('event',{...key,type:'playback-paused',pauseId:1,renderedFrames:1});
 controller.abort();await assert.rejects(done);assert.equal(player.active,null);
 assert.equal(worker.packets.at(-1).type,'playback-cancel');
});

test('real inherited pause commands return only bounded cursor metadata',async()=>{
 const code=`console.log('{"type":"ready"}');require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.type==='stop')process.exit(0);if(m.type==='ping')console.log('{"type":"alive"}');if(m.type==='playback-pause'||m.type==='playback-resume')console.log(JSON.stringify({type:m.type==='playback-pause'?'playback-paused':'playback-resumed',generation:m.generation,turn:m.turn,pauseId:m.pauseId,renderedFrames:0,private:'not forwarded'}))});`;
 const worker=new VoiceWorkerSupervisor({executable:process.execPath,args:['-e',code],heartbeatMs:100,silenceMs:1000});
 try{
  await worker.start();
  assert.equal(worker.playback({...key,type:'playback-pause',pauseId:0}),false);
  for(const type of ['playback-pause','playback-resume']){
   const expected=type==='playback-pause'?'playback-paused':'playback-resumed';
   const result=new Promise(resolve=>{const listener=e=>{if(e.type===expected){worker.off('event',listener);resolve(e)}};worker.on('event',listener)});
   assert.equal(worker.playback({...key,type,pauseId:1}),true);
   assert.deepEqual(await result,{...key,type:expected,pauseId:1,renderedFrames:0});
  }
 }finally{await worker.stop()}
});
