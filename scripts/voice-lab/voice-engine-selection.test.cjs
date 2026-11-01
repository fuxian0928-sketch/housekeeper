const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createVoiceEngineSelection,voiceEngineSelectionError}=require('../../electron/voice-engine-selection.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-engine-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const bundleRoot=path.join(dir,'bundle');fs.mkdirSync(bundleRoot);fs.writeFileSync(path.join(bundleRoot,'bundle.json'),'{}');return {dataDirectory:dir,bundleRoot,verifyBundle:async()=>{}}}
test('selection changes only next boot, preserves current engine, and supports rollback',async t=>{const options=fixture(t),first=createVoiceEngineSelection(options);assert.equal(first.current,'legacy');const saved=await first.save('native');assert.equal(saved.current,'legacy');assert.equal(saved.restartRequired,true);const next=createVoiceEngineSelection(options);assert.equal(next.current,'native');await next.save('legacy');assert.equal(next.current,'native');assert.equal(createVoiceEngineSelection(options).current,'legacy')});
test('failed verification does not replace previous choice',async t=>{const options=fixture(t),engine=createVoiceEngineSelection({...options,verifyBundle:async()=>{throw Error('corrupt')}});await assert.rejects(engine.save('native'));assert.equal(engine.status().requested,'legacy');assert.equal(fs.existsSync(path.join(options.dataDirectory,'voice-engine.json')),false);await assert.rejects(engine.save('anything'))});
test('absent bundle falls back visibly and development override is locked',async t=>{const options=fixture(t);await createVoiceEngineSelection(options).save('native');fs.unlinkSync(path.join(options.bundleRoot,'bundle.json'));const next=createVoiceEngineSelection(options);assert.equal(next.current,'legacy');assert.equal(next.status().requested,'native');assert.equal(next.status().available,false);await assert.rejects(next.save('native'));const forced=createVoiceEngineSelection({...options,forcedNative:true});assert.equal(forced.current,'native');await assert.rejects(forced.save('legacy'))});
test('inspected availability reflects full verification and preserves the saved selection',async t=>{
 const options=fixture(t);
 const engine=createVoiceEngineSelection({...options,verifyBundle:async()=>{throw Error('VOICE_NATIVE_BUNDLE_INVALID')}});
 assert.equal(engine.status().available,true);
 assert.equal((await engine.inspect()).available,false);
 await assert.rejects(engine.save('native'),{message:'VOICE_NATIVE_BUNDLE_INVALID'});
 assert.equal(engine.status().requested,'legacy');
});
test('selection errors distinguish resources from local write failures without leaking details',()=>{
 assert.match(voiceEngineSelectionError(Error('VOICE_NATIVE_BUNDLE_MISSING')),/缺少原生语音资源/);
 assert.match(voiceEngineSelectionError(Error('VOICE_NATIVE_BUNDLE_INVALID')),/资源校验失败/);
 assert.match(voiceEngineSelectionError(Error('EACCES private path or token')),/应用数据目录/);
 assert.doesNotMatch(voiceEngineSelectionError(Error('EACCES private path or token')),/private|token/);
});
