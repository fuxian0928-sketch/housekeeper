const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto');
const {verifyNativeVoiceBundle}=require('../../electron/native-voice-bundle.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'voice-bundle-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const names=['python/python.exe','keywords.txt','scripts/voice-lab/run_duplex.py','scripts/voice-lab/runtime_probe.py','scripts/voice-lab/model.json','scripts/voice-lab/requirements.txt'];
 const files=names.map(name=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');return {path:name,bytes:7,sha256:createHash('sha256').update('fixture').digest('hex')}});
 const manifest={schema:1,platform:'win32-x64',python:'python/python.exe',model:'model',keywords:'keywords.txt',releaseApproved:false,files};
 const write=()=>fs.writeFileSync(path.join(root,'bundle.json'),JSON.stringify(manifest));write();return {root,manifest,write};
}
test('valid index returns only fixed resource paths and preserves unapproved status',async t=>{const {root}=fixture(t);const result=await verifyNativeVoiceBundle(root);assert.equal(result.python,path.join(root,'python/python.exe'));assert.equal(result.releaseApproved,false);assert.equal(result.files,6)});

test('bounded hashing closes all handles on success or failure and never caches a prior result',async t=>{
 const {root,manifest,write}=fixture(t),payload=Buffer.alloc(8192,7);
 for(let i=0;i<32;i++){const name=`model/part-${i}.bin`,file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,payload);manifest.files.push({path:name,bytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex')});}
 write();let active=0,maximum=0;
 const original=fs.promises.open;
 fs.promises.open=async(...args)=>{
  const handle=await original(...args);active++;maximum=Math.max(maximum,active);
  return {stat:()=>handle.stat(),createReadStream:options=>handle.createReadStream(options),async close(){try{await handle.close();}finally{active--;}}};
 };
 t.after(()=>{fs.promises.open=original;});
 assert.equal((await verifyNativeVoiceBundle(root)).files,38);
 assert.ok(maximum>1&&maximum<=8);assert.equal(active,0);
 fs.writeFileSync(path.join(root,'model/part-10.bin'),Buffer.alloc(8192,8));
 await assert.rejects(verifyNativeVoiceBundle(root),{message:'VOICE_NATIVE_BUNDLE_INVALID'});
 assert.equal(active,0);
});
test('tampered, absent and unlisted files all reject with fixed errors',async t=>{
 for(const kind of ['tampered','absent','extra']){const {root}=fixture(t);if(kind==='tampered')fs.writeFileSync(path.join(root,'keywords.txt'),'changed');if(kind==='absent')fs.unlinkSync(path.join(root,'keywords.txt'));if(kind==='extra')fs.writeFileSync(path.join(root,'python','sitecustomize.py'),'unlisted');await assert.rejects(verifyNativeVoiceBundle(root),{message:'VOICE_NATIVE_BUNDLE_INVALID'})}
});
test('manifest rejects traversal, alternate executable and case-colliding paths',async t=>{
 for(const kind of ['traversal','executable','collision']){const {root,manifest,write}=fixture(t);if(kind==='traversal')manifest.files[0].path='../outside';if(kind==='executable')manifest.python='other.exe';if(kind==='collision')manifest.files.push({...manifest.files[0],path:'PYTHON/python.exe'});write();await assert.rejects(verifyNativeVoiceBundle(root),{message:'VOICE_NATIVE_BUNDLE_INVALID'})}
});

test('x64 install tolerates only absent ARM launchers and still checks present ones',async t=>{
 const {root,manifest,write}=fixture(t);
 const optional=[
  'python/Lib/site-packages/pip/_vendor/distlib/t64-arm.exe',
  'python/Lib/site-packages/pip/_vendor/distlib/w64-arm.exe',
  'python/Lib/site-packages/setuptools/cli-arm64.exe',
  'python/Lib/site-packages/setuptools/gui-arm64.exe',
 ];
 for(const name of optional){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');manifest.files.push({path:name,bytes:7,sha256:createHash('sha256').update('fixture').digest('hex')})}
 write();
 for(const name of optional)fs.unlinkSync(path.join(root,name));
 assert.equal((await verifyNativeVoiceBundle(root)).files,10);
 const present=path.join(root,optional[0]);fs.writeFileSync(present,'changed');
 await assert.rejects(verifyNativeVoiceBundle(root),{message:'VOICE_NATIVE_BUNDLE_INVALID'});
 fs.unlinkSync(present);
 fs.unlinkSync(path.join(root,'keywords.txt'));
 await assert.rejects(verifyNativeVoiceBundle(root),{message:'VOICE_NATIVE_BUNDLE_INVALID'});
});

test('host rejects incomplete bundle before loading runtime or opening devices',async t=>{
 const {root}=fixture(t);fs.writeFileSync(path.join(root,'keywords.txt'),'corrupt');let loaded=false;
 const {createNativeVoiceHost}=require('../../electron/native-voice-host.cjs');
 await assert.rejects(createNativeVoiceHost({resourceBundleRoot:root,appRoot:root,dataDirectory:root,loadRuntime:async()=>{loaded=true}}),{message:'VOICE_NATIVE_BUNDLE_INVALID'});
 assert.equal(loaded,false);
});
