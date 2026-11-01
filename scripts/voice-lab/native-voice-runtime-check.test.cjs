const test=require('node:test'),assert=require('node:assert/strict');
const {runRuntimeProbe,verifyNativeVoiceRuntime}=require('../../electron/native-voice-runtime-check.cjs');
const {startNativeVoiceSafely}=require('../../electron/native-voice-startup.cjs');
const run=(source,timeoutMs=2000)=>runRuntimeProbe({executable:process.execPath,args:['-e',source],cwd:process.cwd(),timeoutMs});
test('runtime checker accepts only successful bounded readiness reports',async()=>{
 assert.deepEqual(await run('console.log(JSON.stringify({ready:true}))'),{ready:true});
 for(const source of ['console.log("private path and key")','console.log(JSON.stringify({ready:true,secret:"private"}))','console.log(JSON.stringify({ready:true}));process.exitCode=1','console.log("x".repeat(5000))','console.error("x".repeat(5000));setInterval(()=>{},1000)'])await assert.rejects(run(source),{message:'VOICE_NATIVE_RUNTIME_CHECK_FAILED'});
 for(const code of ['VOICE_NATIVE_PYTHON_VERSION','VOICE_NATIVE_DEPENDENCY_VERSION','VOICE_NATIVE_DEPENDENCY_MISSING','VOICE_NATIVE_DEPENDENCY_LOAD']){
 await assert.rejects(run(`console.log(JSON.stringify({ready:false,code:'${code}'}));process.exitCode=1`),{message:code});
 const response=await startNativeVoiceSafely(async()=>{throw Error(code)});assert.equal(response.host,null);assert.match(response.error,/运行环境/);
 }
});
test('hanging and missing executables fail without forwarding private process output',async()=>{
 await assert.rejects(run('console.error("SECRET");setInterval(()=>{},1000)',100),{message:'VOICE_NATIVE_RUNTIME_CHECK_TIMEOUT'});
 await assert.rejects(verifyNativeVoiceRuntime({appRoot:process.cwd(),python:'X:/missing-private-python.exe'}),{message:'VOICE_NATIVE_RUNTIME_CHECK_FAILED'});
});


test('device preflight failures retain actionable fixed messages',async()=>{
 for(const [code,expected] of [['VOICE_NATIVE_DEVICE_MISSING',/不可用/],['VOICE_NATIVE_DEVICE_AMBIGUOUS',/多个设备/],['VOICE_NATIVE_DEVICE_CHANNELS',/双声道/],['VOICE_NATIVE_DEVICE_ENUMERATION',/无法读取/]]){
  await assert.rejects(run(`console.log(JSON.stringify({ready:false,code:'${code}'}));process.exitCode=1`),{message:code});
  const result=await startNativeVoiceSafely(async()=>{throw Error(code)});assert.match(result.error,expected);
 }
});


test('enumeration IPC boundary validates and strips device rows',async()=>{
 const execute=value=>runRuntimeProbe({executable:process.execPath,args:['-e',`console.log(${JSON.stringify(JSON.stringify(value))})`],cwd:process.cwd(),deviceList:true});
 assert.deepEqual(await execute({ready:true,devices:{inputs:[{name:'mic',available:true,private:'ignored'}],outputs:[]}}),{inputs:[{name:'mic',available:true}],outputs:[]});
 for(const value of [{ready:true},{ready:true,devices:{inputs:[{name:'mic',available:'yes'}],outputs:[]}},{ready:true,devices:{inputs:[{name:'mic',available:true},{name:'mic',available:true}],outputs:[]}}])await assert.rejects(execute(value),/CHECK_FAILED/);
});
