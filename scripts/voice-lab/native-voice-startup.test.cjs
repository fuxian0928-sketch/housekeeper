const test=require('node:test'),assert=require('node:assert/strict');
const {startNativeVoiceSafely}=require('../../electron/native-voice-startup.cjs');
test('failed voice start closes owned runtime without failing application startup',async()=>{
 let closed=false;
 const result=await startNativeVoiceSafely(async()=>({async reconcile(){throw Error('VOICE_KEY_NOT_CONFIGURED');},async close(){closed=true;}}));
 assert.equal(closed,true);assert.equal(result.host,null);assert.match(result.error,/密钥/);
});
test('private errors are not forwarded and successful host is retained',async()=>{
 const failed=await startNativeVoiceSafely(async()=>{throw Error('private-path-and-key');});
 assert.ok(!failed.error.includes('private'));assert.equal(failed.host,null);
 const host={async reconcile(){},async close(){}};
 assert.deepEqual(await startNativeVoiceSafely(async()=>host),{host,error:null});
});

test('startup records the failure category without private process text and diagnostic errors do not block recovery',async()=>{
 const records=[];
 for(const code of ['WORKER_RUNTIME_FAILED','WORKER_START_TIMEOUT','VOICE_LOCAL_START_TIMEOUT','VOICE_SETTINGS_SYNC_FAILED']){
   const result=await startNativeVoiceSafely(async()=>{throw Error(code)}, {onFailure:entry=>records.push(entry)});
   assert.equal(result.host,null);assert.equal(records.at(-1).code,code);assert.equal(records.at(-1).message,result.error);
 }
 const result=await startNativeVoiceSafely(async()=>{throw Error('secret/password in private/path')}, {onFailure:entry=>records.push(entry)});
 assert.equal(records.at(-1).code,'VOICE_STARTUP_FAILED');assert.ok(!JSON.stringify(records).includes('secret'));
 assert.ok(result.error);
 const loggingFailed=await startNativeVoiceSafely(async()=>{throw Error('WORKER_RUNTIME_FAILED')},{onFailure(){throw Error('disk unavailable')}});
 assert.match(loggingFailed.error,/设备打开失败/);
});


test('startup distinguishes actionable resource and configuration failures without exposing details',async()=>{
 const cases={VOICE_NATIVE_BUNDLE_INVALID:'资源包',ASR_REALTIME_NOT_CONFIGURED:'填写',ASR_REALTIME_MODEL_UNSUPPORTED:'实时协议',ASR_INVALID_OFFICIAL_ENDPOINT:'官方',ASR_INVALID_ENDPOINT_PATH:'路径',VOICE_INVALID_SYNTHESIS_CONFIG:'音色',VOICE_INVALID_SPEECH_RATE:'0.5–2',VOICE_INVALID_PROGRESS_CONFIG:'过程播报',VOICE_INVALID_MODE:'对话模式'};
 for(const [code,expected] of Object.entries(cases)){
  let closed=false;
  const result=await startNativeVoiceSafely(async()=>({reconcile:async()=>{throw Error(code)},close:async()=>{closed=true}}));
  assert.equal(result.host,null);assert.equal(closed,true);assert.ok(result.error.includes(expected));assert.ok(!result.error.includes(code));
 }
 const privateResult=await startNativeVoiceSafely(async()=>{throw Error('VOICE_NATIVE_BUNDLE_INVALID private/path secret')});
 assert.ok(!privateResult.error.includes('private'));assert.ok(!privateResult.error.includes('secret'));
});
