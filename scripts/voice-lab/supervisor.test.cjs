const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { VoiceWorkerSupervisor } = require('../../electron/voice-worker-supervisor.cjs');

const responsive = `console.log(JSON.stringify({type:'ready'})); process.stdin.on('data', d=>{for(const l of d.toString().trim().split('\\n')){const m=JSON.parse(l);if(m.type==='ping')console.log(JSON.stringify({type:'alive'}));else process.exit(0)}});`;
const create = code => new VoiceWorkerSupervisor({ executable: process.execPath, args: ['-e',code], startupMs: 500, heartbeatMs: 30, silenceMs: 200, stopMs: 100 });

test('playback health forwards only bounded numeric counters and rejects corrupt telemetry',async()=>{
 for(const variant of ['legacy','device','queue-overflow','invalid-device']){
  const invalid=['queue-overflow','invalid-device'].includes(variant);
  const health={startupFrames:10,pausedFrames:20,underrunFrames:30,underrunCount:1,queuedFrames:variant==='queue-overflow'?201:50,secret:'PRIVATE',
   ...(variant==='device'||variant==='invalid-device'?{deviceOutputUnderflows:2,headOutputUnderflows:1,deviceMaxGapMs:60,headMaxGapMs:variant==='invalid-device'?-1:50}:{})};
  const code=`console.log(JSON.stringify({type:'ready'}));let sent=false;process.stdin.on('data',data=>{for(const line of data.toString().trim().split('\\n')){const event=JSON.parse(line);if(event.type!=='ping')process.exit(0);console.log(JSON.stringify({type:'alive'}));if(!sent){sent=true;console.log(JSON.stringify({type:'playback-progress',generation:1,turn:1,renderedFrames:1,health:${JSON.stringify(health)}}));}}});`;
  const host=create(code),events=[];host.on('event',e=>events.push(e));const fault=once(host,'fault');
  try{await host.start();if(invalid)assert.equal((await fault)[0].code,'INVALID_PLAYBACK_EVENT');else{await new Promise(resolve=>setTimeout(resolve,30));const progress=events.find(e=>e.type==='playback-progress');assert.ok(progress);assert.equal(progress.health.underrunFrames,30);assert.equal(Object.hasOwn(progress.health,'secret'),false);if(variant==='device'){assert.equal(progress.health.deviceOutputUnderflows,2);assert.equal(progress.health.headOutputUnderflows,1);assert.equal(progress.health.headMaxGapMs,50);}else assert.equal(Object.hasOwn(progress.health,'headOutputUnderflows'),false);}}
  finally{await host.stop();}
 }
});

test('one worker at a time, bounded graceful stop and fresh generation on restart', async () => {
  const host=create(responsive);
  const first=await host.start();
  await assert.rejects(host.start(),/already running/);
  await host.stop();
  assert.equal(host.current,null);
  const second=await host.start();
  assert.ok(second.generation>first.generation);
  await host.stop();
});
test('startup hang is killed and start rejects', async () => {
  const host=create('setInterval(()=>{},1000)');
  const closed=once(host,'closed');
  await assert.rejects(host.start(),/START_TIMEOUT/);
  await closed;
  assert.equal(host.current,null);
});
test('missing heartbeat terminates only owned process', async () => {
  const host=create(`console.log('{"type":"ready"}'); setInterval(()=>{},1000)`);
  const fault=once(host,'fault'); const closed=once(host,'closed');
  await host.start();
  assert.equal((await fault)[0].code,'WORKER_HEARTBEAT_TIMEOUT');
  await closed;
});
test('oversized/untrusted output does not reach consumer', async () => {
  const host=create(`console.log('x'.repeat(20000));setInterval(()=>{},1000)`);
  const events=[];host.on('event',e=>events.push(e));
  const closed=once(host,'closed');
  await assert.rejects(host.start(),/OUTPUT_OVERFLOW/);
  await closed;assert.deepEqual(events,[]);
});
test('ready metadata cannot forward arbitrary sensitive payloads', async () => {
  const host=create(`console.log(JSON.stringify({type:'ready',secret:'private'}));process.stdin.on('data',()=>process.exit(0))`);
  const events=[];host.on('event',e=>events.push(e));
  await host.start();await host.stop();
  assert.deepEqual(Object.keys(events[0]).sort(),['generation','type']);
});
test('stop before ready rejects pending start and reaps child', async () => {
  const host=create('setInterval(()=>{},1000)');
  const started=host.start();
  const rejection=assert.rejects(started,/WORKER_STOPPED/);
  await host.stop();await rejection;
  assert.equal(host.current,null);
});
test('commands from an obsolete process generation are not sent', async () => {
  const host=create(responsive);
  const current=await host.start();
  try {
    assert.equal(host.command({generation:current.generation-1,audioGeneration:1,turn:1,type:'answer-finished'}),false);
    assert.equal(host.command({generation:current.generation,audioGeneration:1,turn:1,type:'arbitrary'}),false);
    assert.equal(host.command({generation:current.generation,audioGeneration:0,turn:1,type:'dismiss'}),false);
  } finally {await host.stop();}
});

test('private PCM channel maps clock and does not expose samples in metadata', async () => {
  const script = `console.log(JSON.stringify({type:'ready'}));let sent=false;process.stdin.on('data',d=>{for(const l of d.toString().trim().split('\\n')){const m=JSON.parse(l);if(m.type!=='ping')process.exit(0);console.log(JSON.stringify({type:'alive',token:m.token,workerClockMs:performance.now()}));if(!sent){sent=true;console.log(JSON.stringify({type:'turn-start',generation:1,turn:1}));console.log(JSON.stringify({type:'audio',generation:1,turn:1,sequence:0,capturedAtMs:performance.now(),pcm:Buffer.alloc(320).toString('base64')}));console.log(JSON.stringify({type:'turn-end',generation:1,turn:1,frameCount:1}));}}});`;
  const frames=[],events=[];
  const host=new VoiceWorkerSupervisor({executable:process.execPath,args:['-e',script],audioConsumer:p=>frames.push(p),startupMs:1000,heartbeatMs:30,silenceMs:300,stopMs:100});
  let finish;
  const done=new Promise(resolve=>finish=resolve);
  host.on('event',e=>{events.push(e);if(e.type==='turn-end')finish();});
  host.on('fault',e=>finish(e));
  try {
    await host.start();
    const failure=await Promise.race([done,new Promise(resolve=>setTimeout(()=>resolve('timeout'),1000))]);
    assert.equal(failure,undefined);
    assert.equal(frames.length,1);assert.equal(frames[0].pcm.length,320);
    assert.ok(performance.now()-frames[0].capturedAt<300);
    assert.equal(events.some(e=>'pcm' in e || e.type==='audio'),false);
    assert.equal(events.find(e=>e.type==='turn-end').frameCount,1);
  } finally {await host.stop();}
});

test('native capture stall is surfaced even when cleanup hangs', async () => {
  const host=create(`console.log(JSON.stringify({type:'ready'}));setTimeout(()=>console.log(JSON.stringify({type:'stopped',failure:'AudioCaptureStalled'})),20);setInterval(()=>{},1000)`);
  const fault=once(host,'fault'), closed=once(host,'closed');
  await host.start();
  assert.equal((await fault)[0].code,'AUDIO_CAPTURE_STALLED');
  await closed; assert.equal(host.current,null);
});

test('manual control uses only the live child pipe and returns sanitized listening metadata', async () => {
 const host=create(`console.log('{"type":"ready"}');require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.type==='ping')console.log('{"type":"alive"}');if(m.type==='manual-wake')console.log(JSON.stringify({type:'listening',generation:1,turn:0,reason:'manual-wake'}));if(m.type==='stop')process.exit(0)});`);
 assert.equal(host.sessionControl('manual-wake'),false);
 await host.start();
 assert.equal(host.sessionControl('run-arbitrary'),false);
 const listening=new Promise(resolve=>host.on('event',e=>{if(e.type==='listening')resolve(e)}));
 assert.equal(host.sessionControl('manual-wake'),true);
 const event=await listening;assert.equal(event.reason,'manual-wake');assert.equal(event.turn,0);
 await host.stop();assert.equal(host.sessionControl('manual-wake'),false);
});


test('interruption PCM stays private and resolution is generation-scoped', async () => {
  const code = `let sent=false; console.log(JSON.stringify({type:'ready'})); require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.type==='stop')process.exit(0);if(m.type==='ping'){console.log(JSON.stringify({type:'alive',token:m.token,workerClockMs:performance.now()}));if(!sent){sent=true;for(const type of ['interruption-start','interruption-audio','interruption-end'])console.log(JSON.stringify({type,phase:'processing',generation:1,turn:1,pauseId:7,frameCount:1,sequence:0,capturedAtMs:performance.now(),pcm:Buffer.alloc(320).toString('base64'),secret:'private'}));}}if(m.type==='interruption-resolve')console.log(JSON.stringify({type:'interruption-cancelled',generation:m.generation,turn:m.turn,pauseId:m.pauseId}));});`;
  const received=[], events=[];
  const host=new VoiceWorkerSupervisor({executable:process.execPath,args:['-e',code],startupMs:1000,heartbeatMs:100,silenceMs:1000,stopMs:100,interruptionConsumer:p=>{received.push(p);return true;}});
  let done; const ended=new Promise(resolve=>{done=resolve;});
  host.on('event',e=>{events.push(e);if(e.type==='interruption-end')done();});
  try {
    await host.start(); await ended;
    assert.equal(received.length,1);assert.equal(received[0].pauseId,7);
    assert.equal(events.find(e=>e.type==='interruption-start').phase,'processing');
    assert.ok(events.every(e=>!('pcm' in e)&&!('secret' in e)));
    assert.equal(host.resolveInterruption({workerGeneration:2,audioGeneration:1,turn:1,pauseId:7},'stop'),false);
    assert.equal(host.resolveInterruption({workerGeneration:1,audioGeneration:1,turn:1,pauseId:7},'interrupt'),true);
  } finally { await host.stop(); }
});
