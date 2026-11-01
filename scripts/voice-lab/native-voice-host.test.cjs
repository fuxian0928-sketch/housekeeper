const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createNativeVoiceHost}=require('../../electron/native-voice-host.cjs');
test('host serializes device ownership, configuration changes and shutdown',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-host-'));
 const configFile=path.join(dir,'config.json');
 fs.writeFileSync(configFile,JSON.stringify({python:process.execPath,model:dir,keywords:__filename,inputName:'fixture-in',outputName:'fixture-out',connection:{voice:'Cherry'}}));
 fs.writeFileSync(path.join(dir,'native-voice-history.json'),JSON.stringify({id:'previous-history'}));
 let config={enabled:true,voiceEnabled:true,mockMode:false,wakeWordEnabled:true,voiceRoutingMode:'work',voiceProjectId:'p1',voiceNoiseSuppression:true,voiceAutoGain:true,voiceEchoDelayMs:80};
 let connection={voice:'Serena',synthesisModel:'qwen3-tts-flash-realtime'};
 let starts=0,stops=0,closes=0,options,worker; const controls=[], timings=[], wakeSettings=[];
 const host=await createNativeVoiceHost({configFile,appRoot:dir,dataDirectory:dir,port:43110,readCompanionConfig:()=>config,readConnection:()=>connection,key:()=>null,readDevices:()=>({inputName:'chosen-in',outputName:'chosen-out'}),
 prepareKeywords:()=>__filename, verifyAssets:async()=>{}, verifyRuntime:async()=>{}, loadRuntime:async()=>({createNativeVoiceRuntime(value){options=value;worker=value.createWorker(()=>true);worker.configureTiming=value=>{timings.push(value);return true};worker.configureWake=value=>{wakeSettings.push(value);return true};worker.sessionControl=type=>{controls.push(type);return true};return {async start(){starts++;worker.emit('event',{type:'ready',generation:starts});},async stop(){stops++;},async close(){closes++;}};}})});
 assert.deepEqual(options.initialSessionCloses,[{conversationId:'previous-history',routingMode:'work',projectId:'p1'}]);
 assert.match(options.deviceId,/^[0-9a-f-]{36}$/i);
 assert.equal(options.conversation.read(),null);
 assert.equal(fs.existsSync(path.join(dir,'native-voice-history.json')),false);
 assert.ok(worker.options.args.includes('--noise-suppression'));assert.ok(worker.options.args.includes('--auto-gain'));assert.equal(worker.options.args[worker.options.args.indexOf('--echo-delay-ms')+1],'80');
 assert.equal(worker.options.args[worker.options.args.indexOf('--input-name')+1],'chosen-in');
 assert.equal(worker.options.args[worker.options.args.indexOf('--output-name')+1],'chosen-out');
 assert.equal(starts,0);assert.equal(host.control('wake'),false);
 await Promise.all([host.reconcile(),host.reconcile()]);assert.equal(starts,1);
 assert.deepEqual(timings[0],{voiceContinuousEnabled:true,voiceMinSpeechMs:120,voiceMaxUtteranceSeconds:30,voiceIdleSeconds:300,voiceEndSilenceMs:1000, voiceBargeInEnabled: true});
 config={...config,voiceMinSpeechMs:250,voiceIdleSeconds:600,voiceEndSilenceMs:1500, voiceBargeInEnabled: true};await host.reconcile();assert.equal(starts,1);assert.deepEqual(timings.at(-1),{voiceContinuousEnabled:true,voiceMinSpeechMs:250,voiceMaxUtteranceSeconds:30,voiceIdleSeconds:600,voiceEndSilenceMs:1500, voiceBargeInEnabled: true});
 config={...config,enabled:false,wakeWordEnabled:false};await host.reconcile();assert.equal(starts,1);assert.equal(wakeSettings.at(-1),false);assert.equal(host.control('wake'),true);
 config={...config,enabled:true,wakeWordEnabled:true};await host.reconcile();
 assert.equal(host.control('wake'),true);assert.equal(host.control('dismiss'),true);assert.equal(host.control('arbitrary'),false);assert.deepEqual(controls,['manual-wake','manual-wake','manual-dismiss']);assert.equal(host.control('preview'),true);assert.equal(controls.at(-1),'voice-preview');
 assert.equal(options.settings().routingMode,'work');
 assert.equal(options.settings().wakeWord,'希微希微');
 config={...config,wakeWord:'小E小E'};assert.equal(options.settings().wakeWord,'希微希微');
 config={...config,wakeWord:'你好秘书'};assert.equal(options.settings().wakeWord,'你好秘书');
 assert.equal(options.settings().voicePrefetchEnabled,false);assert.equal(options.settings().voicePrefetchAttempts,2);
 config={...config,voicePrefetchEnabled:false,voicePrefetchAttempts:1};await host.reconcile();
 assert.equal(options.settings().voicePrefetchEnabled,false);assert.equal(options.settings().voicePrefetchAttempts,1);
 config={...config,voiceFarewellText:'主人，下次聊。'};assert.equal(options.settings().voiceFarewellText,'主人，下次聊。');
 assert.equal(options.settings().voiceSpeechRate,1);
 config={...config,voiceSpeechRate:1.25};assert.equal(options.settings().voiceSpeechRate,1.25);
 assert.equal(options.settings().voice,'Serena');
 const held=host.connectionSnapshot();assert.equal(held.settings.voice,'Serena');assert.deepEqual(held.keys,{recognition:null,synthesis:null});
 connection={...connection,voice:'Cherry'};assert.equal(options.settings().voice,'Cherry');
 assert.equal(held.settings.voice,'Serena');
 connection={voice:'',synthesisModel:''};assert.equal(options.settings().voice,''); // Never fall back to stale file configuration.
 options.conversation.save('test-history');assert.equal(options.conversation.read(),'test-history');
 assert.equal(options.conversation.clear(),'test-history');assert.equal(options.conversation.read(),null);
 assert.equal(fs.existsSync(path.join(dir,'native-voice-history.json')),false);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'native-voice-close-pending.json'),'utf8')).pending.map(row=>row.conversationId),['previous-history','test-history']);
 options.onSessionCloseAcknowledged('test-history');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'native-voice-close-pending.json'),'utf8')).pending.map(row=>row.conversationId),['previous-history']);
 config={...config,voiceEnabled:false};await host.reconcile();assert.equal(stops,1);assert.equal(host.control('wake'),false);
 config={...config,voiceEnabled:true};await host.reconcile();assert.equal(starts,2);
 config={...config,mockMode:true};await host.reconcile();assert.equal(stops,3);assert.equal(host.control('wake'),false);
 worker.emit('closed', {generation:1});
 config={...config,mockMode:false};await host.reconcile();assert.equal(starts,3);assert.equal(host.control('wake'),true);
 await host.close();await host.reconcile();assert.equal(closes,1);assert.equal(host.control('wake'),false);assert.equal(starts,3);
});

test('fault recovery retires the old runtime before restart and close cancels the next retry', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-recovery-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const configFile=path.join(dir,'config.json');
 fs.writeFileSync(configFile,JSON.stringify({python:process.execPath,model:dir,keywords:__filename,inputName:'fixture-in',outputName:'fixture-out',connection:{voice:'Cherry'}}));
 let worker; const events=[]; let recovered;
 const recoveryDone=new Promise(resolve=>{recovered=resolve});
 const host=await createNativeVoiceHost({configFile,appRoot:dir,dataDirectory:dir,port:43110,readCompanionConfig:()=>({enabled:true,mockMode:false}),key:()=>null,
 onStatus:e=>{if(e.type==='recovered'&&events.filter(x=>x==='start').length===2) recovered()},
 prepareKeywords:()=>__filename, verifyAssets:async()=>{}, verifyRuntime:async()=>{}, loadRuntime:async()=>({createNativeVoiceRuntime(options){worker=options.createWorker(()=>true);return {async start(){events.push('start')},async stop(){events.push('stop');worker.emit('closed')},async close(){events.push('close')}}}})});
 t.after(()=>host.close());
 await host.reconcile(); worker.emit('fault',{code:'device-lost'});
 await Promise.race([recoveryDone,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('recovery timeout')),2000);timer.unref()})]);
 assert.deepEqual(events,['start','stop','start']);
 worker.emit('fault',{code:'device-lost'}); await host.close();
 await new Promise(resolve=>setTimeout(resolve,600));
 assert.equal(events.filter(x=>x==='start').length,2);
});

test('host shutdown persists bound playback and a new host supplies it to chat',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-host-receipt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const configFile=path.join(dir,'config.json');fs.writeFileSync(configFile,JSON.stringify({python:process.execPath,model:dir,keywords:__filename,inputName:'in',outputName:'out',connection:{}}));
 let options,worker;
 const open=()=>createNativeVoiceHost({configFile,appRoot:dir,dataDirectory:dir,port:43110,readCompanionConfig:()=>({enabled:false}),key:()=>null,
 prepareKeywords:()=>__filename, verifyAssets:async()=>{}, verifyRuntime:async()=>{}, loadRuntime:async()=>({createNativeVoiceRuntime(value){options=value;worker=value.createWorker(()=>true);return {async start(){},async stop(){},async close(){}};}})});
 const first=await open(),key={generation:1,audioGeneration:1,turn:1};worker.emit('event',{...key,type:'turn-start'});
 options.onRecognition({workerGeneration:1,audioGeneration:1,turn:1,type:'final',text:'PRIVATE_TRANSCRIPT'});options.onResponseStage(key,'tts-ready');
 options.onAudioPacket(key,'answer',320);worker.emit('event',{...key,type:'playback-submitted',renderedFrames:1});
 options.onAnswer(key,'conversation','a'.repeat(64),'message');options.onPlaybackReceipt(key,1);await first.close();
 const trace=fs.readFileSync(path.join(dir,'logs/native-voice-stages.json'),'utf8');assert.ok(!trace.includes('PRIVATE_TRANSCRIPT'));assert.ok(trace.includes('asr-final'));assert.ok(trace.includes('tts-ready'));
 const second=await open();assert.equal(options.playbackContext('conversation').assistantMessageId,'message');assert.equal(options.playbackContext('conversation').state,'submitted');
 assert.equal(options.playbackContext('other'),null);assert.equal(second.playbackStatus().length,0);await second.close();
});

test('pending voice close survives restart until local server acknowledgement',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-close-outbox-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const configFile=path.join(dir,'config.json');
 fs.writeFileSync(configFile,JSON.stringify({python:process.execPath,model:dir,keywords:__filename,inputName:'in',outputName:'out',connection:{}}));
 let options;
 const open=()=>createNativeVoiceHost({configFile,appRoot:dir,dataDirectory:dir,port:43110,
   readCompanionConfig:()=>({enabled:false,voiceRoutingMode:'work',voiceProjectId:'project-a'}),key:()=>null,
   prepareKeywords:()=>__filename,verifyAssets:async()=>{},verifyRuntime:async()=>{},
   loadRuntime:async()=>({createNativeVoiceRuntime(value){options=value;return {async start(){},async stop(){},async close(){}};}})});
 const first=await open();const deviceId=options.deviceId;
 options.conversation.save('session-a');assert.equal(options.conversation.clear(),'session-a');
 await first.close();
 const second=await open();
 assert.equal(options.deviceId,deviceId);
 assert.deepEqual(options.initialSessionCloses,[{conversationId:'session-a',routingMode:'work',projectId:'project-a'}]);
 options.onSessionCloseAcknowledged('session-a');await second.close();
 const third=await open();assert.deepEqual(options.initialSessionCloses,[]);await third.close();
});
