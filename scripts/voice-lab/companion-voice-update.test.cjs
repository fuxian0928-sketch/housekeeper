const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requiresVoiceReconcile,restoredVoiceFlags,nativeCompanionSettingsChanges,migrateNativeVoiceFlags,needsCloudVoiceKeys,assertNativeVoiceConnectionReady } = require('../../electron/companion-voice-update.cjs');

test('switching to local speech does not read cloud keys; cloud profiles still validate both credentials and models',()=>{
  assert.doesNotThrow(()=>assertNativeVoiceConnectionReady({speechExecution:'local'},()=>{throw Error('cloud keys must not be touched')}));
  assert.throws(()=>assertNativeVoiceConnectionReady({speechExecution:'cloud'},()=>({recognition:'missing',synthesis:'configured'})),/密钥/);
  const configured=()=>({recognition:'configured',synthesis:'configured'});
  assert.throws(()=>assertNativeVoiceConnectionReady({speechExecution:'cloud'},configured),/补全/);
  assert.doesNotThrow(()=>assertNativeVoiceConnectionReady({speechExecution:'cloud',speechServiceBaseUrl:'https://example.org',speechRealtimeRecognitionModel:'asr',speechRealtimeSynthesisBaseUrl:'https://example.org',speechRealtimeSynthesisModel:'tts',speechRealtimeVoice:'voice'},configured));
});

test('the actual engine restart IPC allows a fresh local installation without cloud keys',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const source=fs.readFileSync(require.resolve('../../electron/main.cjs'),'utf8');
 const start=source.indexOf("ipcMain.handle('companion:restart-for-voice-engine'");
 const end=source.indexOf('\n});',start)+4;
 assert.ok(start>=0&&end>start);
 for(const local of [true,false]){
  let handler,keyReads=0,relaunches=0;
  const context={
   ipcMain:{handle(_name,value){handler=value}},assertVoiceSettingsSender(){},isQuitting:false,
   voiceEngineSelection:{status:()=>({restartRequired:true,requested:'native'})},
   nativeVoiceDevices:{list:async()=>({inputs:[{name:'mic',available:true}],outputs:[{name:'speaker',available:true}],selected:{inputName:'mic',outputName:'speaker'}})},
   fetch:async()=>({ok:true,json:async()=>({speechExecution:local?'local':'cloud'})}),appPort:43110,
   voiceSecrets:{status(){keyReads++;return {recognition:'missing',synthesis:'missing'}}},
   require:()=>require('../../electron/companion-voice-update.cjs'),
   app:{relaunch(){relaunches++},quit(){}},setImmediate(){},AbortSignal
  };
  vm.runInNewContext(source.slice(start,end),context);
  if(local){assert.equal(await handler({}),true);assert.equal(keyReads,0);assert.equal(relaunches,1);}
  else{await assert.rejects(handler({}),/密钥/);assert.equal(keyReads,1);assert.equal(relaunches,0);}
 }
});

test('local voice boots without cloud keys and is independent of hiding the desktop avatar',()=>{
 assert.deepEqual(restoredVoiceFlags({enabled:false},true),{voiceEnabled:true,mockMode:false});
 assert.deepEqual(restoredVoiceFlags({voiceEnabled:false,mockMode:false},true),{voiceEnabled:false,mockMode:false});
 assert.deepEqual(restoredVoiceFlags({mockMode:true},true),{voiceEnabled:true,mockMode:false});
 assert.equal(restoredVoiceFlags({},false).mockMode,true);
 assert.equal(needsCloudVoiceKeys({speechExecution:'local'}),false);
 assert.equal(needsCloudVoiceKeys({speechExecution:'cloud'}),true);
});

test('the diagnosed enabled-plus-simulated configuration migrates without overriding an explicit off or legacy preview',()=>{
 const companyFlags={voiceEnabled:true,mockMode:true};
 const restored=restoredVoiceFlags(companyFlags,true);
 assert.deepEqual(restored,{voiceEnabled:true,mockMode:false});
 assert.deepEqual(restoredVoiceFlags(restored,true),restored);
 assert.deepEqual(restoredVoiceFlags({voiceEnabled:false,mockMode:true},true),{voiceEnabled:false,mockMode:true});
 assert.deepEqual(restoredVoiceFlags(companyFlags,false),companyFlags);
 assert.deepEqual(nativeCompanionSettingsChanges({...companyFlags,opacity:.8},true),{opacity:.8});
 assert.deepEqual(nativeCompanionSettingsChanges({...companyFlags,opacity:.8},false),{...companyFlags,opacity:.8});
});

test('the actual settings IPC cannot restore simulated mode or re-enable voice from an outdated draft',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const source=fs.readFileSync(require.resolve('../../electron/main.cjs'),'utf8');
 const start=source.indexOf("ipcMain.handle('companion:update-config'");
 const end=source.indexOf('\n});',start)+4;
 assert.ok(start>=0&&end>start);
 for(const enabled of [true,false]){
  let handler;
  const before={voiceEnabled:enabled,mockMode:false,opacity:1};
  const context={ipcMain:{handle(_name,value){handler=value}},assertVoiceSettingsSender(){},nativeVoiceManaged:true,
   require:()=>require('../../electron/companion-voice-update.cjs'),readCompanionConfig:()=>before,
   applyCompanionConfig:changes=>({...before,...changes}),nativeVoiceHost:null};
  vm.runInNewContext(source.slice(start,end),context);
  const next=await handler({},{voiceEnabled:!enabled,mockMode:true,opacity:.8});
  assert.equal(next.voiceEnabled,enabled);assert.equal(next.mockMode,false);assert.equal(next.opacity,.8);
 }
});

test('startup persists the native legacy-flag migration once and preserves all other preferences',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-voice-migration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'desktop-companion.json');
 const saved={voiceEnabled:true,mockMode:true,enabled:false,speechVolume:67,position:{x:2,y:3},voiceIdleSeconds:300};
 fs.writeFileSync(file,JSON.stringify(saved));
 assert.equal(migrateNativeVoiceFlags(file,true),true);
 const after=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.deepEqual(after,{...saved,mockMode:false});
 assert.equal(migrateNativeVoiceFlags(file,true),false);
 assert.equal(restoredVoiceFlags(after,true).mockMode,false);
 fs.writeFileSync(file,JSON.stringify({...saved,voiceEnabled:false}));
 assert.equal(migrateNativeVoiceFlags(file,true),false);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).mockMode,true);
 fs.writeFileSync(file,JSON.stringify(saved));
 assert.equal(migrateNativeVoiceFlags(file,false),false);
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),saved);
 fs.writeFileSync(file,'invalid');assert.equal(migrateNativeVoiceFlags(file,true),false);assert.equal(fs.readFileSync(file,'utf8'),'invalid');
});

test('appearance and camera saves do not depend on native voice availability', () => {
  const before = { appearance: 'character', opacity: 1, cameraDeviceId: '', voiceEnabled: true, voiceIdleSeconds: 300 };
  assert.equal(requiresVoiceReconcile(before, { ...before, appearance: 'icon', opacity: 0.9, cameraDeviceId: 'camera-1' }), false);
  assert.equal(requiresVoiceReconcile(before, { ...before }), false);
});

test('changed voice and wake settings still apply to native voice', () => {
  const before = { appearance: 'character', voiceEnabled: true, voiceIdleSeconds: 300, wakeWordEnabled: true };
  assert.equal(requiresVoiceReconcile(before, { ...before, voiceIdleSeconds: 600 }), true);
  assert.equal(requiresVoiceReconcile(before, { ...before, wakeWordEnabled: false }), true);
  assert.equal(requiresVoiceReconcile(before, { ...before, voiceEnabled: false }), true);
});
