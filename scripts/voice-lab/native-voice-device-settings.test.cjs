const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createNativeVoiceDeviceSettings}=require('../../electron/native-voice-device-settings.cjs');
const fallback=()=>({inputName:'old-in',outputName:'old-out'});
const devices={inputs:[{name:'in',available:true}],outputs:[{name:'out',available:true},{name:'bad',available:false}]};

test('a saved selection preserves the real public reconnect failure and remains retryable',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-device-failure-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let connected=false;
 const service=createNativeVoiceDeviceSettings({dataDirectory:dir,fallback,enumerate:async()=>devices,apply:async()=>connected,failure:()=> '音频设备启动超时，请检查设备权限。'});
 assert.deepEqual(await service.save({inputName:'in',outputName:'out'}),{saved:true,applied:false,error:'音频设备启动超时，请检查设备权限。'});
 assert.deepEqual(service.read(),{inputName:'in',outputName:'out'});
 connected=true;
 assert.deepEqual(await service.save({inputName:'in',outputName:'out'}),{saved:true,applied:true});
});
test('device selections persist separately; invalid/disconnected choices leave saved data intact',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-device-settings-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let applied=0;
 const service=createNativeVoiceDeviceSettings({dataDirectory:dir,fallback,enumerate:async()=>devices,apply:async()=>{applied++;return true}});
 assert.deepEqual((await service.list()).selected,fallback());
 for(const value of [{inputName:'in',outputName:'bad'},{inputName:'missing',outputName:'out'},{inputName:1,outputName:'out'}])await assert.rejects(service.save(value));
 assert.equal(applied,0);assert.deepEqual(service.read(),fallback());
 assert.deepEqual(await service.save({inputName:'in',outputName:'out',python:'evil'}),{saved:true,applied:true});
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'native-voice-devices.json'))),{inputName:'in',outputName:'out'});
 const reopened=createNativeVoiceDeviceSettings({dataDirectory:dir,fallback,enumerate:async()=>devices,apply:async()=>{throw Error('failed')}});
 assert.equal(reopened.read().inputName,'in');assert.deepEqual(await reopened.save({inputName:'in',outputName:'out'}),{saved:true,applied:false});
});
test('rapid saves serialize reconnects and snapshot caller arguments',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-devices-serial-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let active=0,maximum=0,calls=0;
 const service=createNativeVoiceDeviceSettings({dataDirectory:dir,fallback,enumerate:async()=>devices,apply:async()=>{maximum=Math.max(maximum,++active);calls++;await new Promise(r=>setTimeout(r,10));active--;return true}});
 const value={inputName:'in',outputName:'out'},first=service.save(value);value.outputName='bad';await Promise.all([first,service.save({inputName:'in',outputName:'out'})]);assert.equal(calls,2);assert.equal(maximum,1);
});
test('installed defaults migrate legacy endpoint names while explicit manual choices persist',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-defaults-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'native-voice-devices.json');fs.writeFileSync(file,JSON.stringify(fallback()));
 const defaults={inputName:'__system_default__',outputName:'__system_default__'};
 const catalog={inputs:[...devices.inputs,{name:'__system_default__',available:true}],outputs:[...devices.outputs,{name:'__system_default__',available:true}]};
 const service=createNativeVoiceDeviceSettings({dataDirectory:dir,fallback,enumerate:async()=>catalog,apply:async()=>true,systemDefaults:true});
 assert.deepEqual(service.read(),defaults);await service.save({inputName:'in',outputName:'out'});
 assert.deepEqual(service.read(),{inputName:'in',outputName:'out'});
 assert.equal(JSON.parse(fs.readFileSync(file)).followSystemDefault,false);
 await service.save(defaults);assert.deepEqual(service.read(),defaults);
});
