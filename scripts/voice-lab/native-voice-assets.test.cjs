const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const {verifyNativeVoiceAssets}=require('../../electron/native-voice-assets.cjs');
const {createNativeVoiceHost}=require('../../electron/native-voice-host.cjs');
const {startNativeVoiceSafely}=require('../../electron/native-voice-startup.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-assets-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directory=path.join(root,'scripts/voice-lab');fs.mkdirSync(directory,{recursive:true});
 const assets=['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map((file,i)=>{const body=Buffer.from(file==='tokens.txt'?'x 0\niǎo 1\nIY1 2\ny 3\nī 4\nì 5\nw 6\nēi 7\n':'fixture'+i);fs.writeFileSync(path.join(root,file),body);return {file,sha256:createHash('sha256').update(body).digest('hex')}});
 const manifest=path.join(directory,'model.json');fs.writeFileSync(manifest,JSON.stringify({provenance:{runtimeAssets:assets}}));
 return {root,manifest,assets};
}
test('preflight verifies bytes and rejects missing, truncated, modified and invalid manifests',async t=>{
 const {root,manifest,assets}=fixture(t),input={appRoot:root,model:root};
 assert.deepEqual(await verifyNativeVoiceAssets(input),{verified:true,files:4});
 const file=path.join(root,assets[0].file),original=fs.readFileSync(file);
 for(const bytes of [Buffer.from('corrupt'),original.subarray(0,3)]){fs.writeFileSync(file,bytes);await assert.rejects(verifyNativeVoiceAssets(input),/ASSET_INVALID/);}
 fs.unlinkSync(file);await assert.rejects(verifyNativeVoiceAssets(input),/ASSET_MISSING/);fs.writeFileSync(file,original);
 for(const rows of [assets.slice(1),[assets[0],assets[0],assets[2],assets[3]],[{...assets[0],file:'../outside'},...assets.slice(1)]]){
 fs.writeFileSync(manifest,JSON.stringify({provenance:{runtimeAssets:rows}}));await assert.rejects(verifyNativeVoiceAssets(input),/MANIFEST_INVALID/);
 }
});
test('host checks assets before loading runtime and again before reopening audio',async t=>{
 const {root,assets}=fixture(t);const configFile=path.join(root,'config.json');
 fs.writeFileSync(configFile,JSON.stringify({python:process.execPath,model:root,keywords:__filename,inputName:'in',outputName:'out'}));
 let enabled=true,loads=0,starts=0;
 const options={configFile,appRoot:root,dataDirectory:root,port:43110,readCompanionConfig:()=>({enabled,voiceEnabled:enabled,mockMode:false}),key:()=>null,
 verifyRuntime:async()=>{}, loadRuntime:async()=>{loads++;return {createNativeVoiceRuntime:()=>({start:async()=>{starts++},stop:async()=>{},close:async()=>{}})}}};
 const file=path.join(root,assets[0].file),original=fs.readFileSync(file);fs.writeFileSync(file,'corrupt');
 const failed=await startNativeVoiceSafely(()=>createNativeVoiceHost(options));assert.equal(loads,0);assert.equal(starts,0);assert.equal(failed.host,null);assert.match(failed.error,/校验失败/);assert.ok(!failed.error.includes(root));
 fs.writeFileSync(file,original);const host=await createNativeVoiceHost(options);t.after(()=>host.close());await host.reconcile();assert.equal(starts,1);
 enabled=false;await host.reconcile();fs.writeFileSync(file,'corrupt');enabled=true;
 await assert.rejects(host.reconcile(),/ASSET_INVALID/);assert.equal(starts,1);
 fs.writeFileSync(file,original);await host.reconcile();assert.equal(starts,2);
});


test('turning voice off during preflight prevents opening a device afterwards',async t=>{
 const {root}=fixture(t),configFile=path.join(root,'config.json');
 fs.writeFileSync(configFile,JSON.stringify({python:process.execPath,model:root,keywords:__filename,inputName:'in',outputName:'out'}));
 let enabled=true,checks=0,starts=0,release,entered;
 const pending=new Promise(resolve=>{release=resolve}),checking=new Promise(resolve=>{entered=resolve});
 const host=await createNativeVoiceHost({configFile,appRoot:root,dataDirectory:root,port:43110,key:()=>null,readCompanionConfig:()=>({enabled,voiceEnabled:enabled,mockMode:false}),
 verifyAssets:async()=>{if(++checks===2){entered();await pending}},
 verifyRuntime:async()=>{}, loadRuntime:async()=>({createNativeVoiceRuntime:()=>({start:async()=>{starts++},stop:async()=>{},close:async()=>{}})})});
 t.after(()=>host.close());const start=host.reconcile();await checking;enabled=false;release();await start;assert.equal(starts,0);
});
