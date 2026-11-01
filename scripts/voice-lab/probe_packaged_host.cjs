// Execute with packaged Electron in RUN_AS_NODE mode. No microphone or cloud calls.
const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
async function probe(directory){
 const resources=path.resolve(directory,'resources'),appRoot=path.join(resources,'app.asar'),bundleRoot=path.join(resources,'native-voice');
 const {createNativeVoiceHost}=require(path.join(appRoot,'electron/native-voice-host.cjs'));
 const {verifyNativeVoiceRuntime}=require(path.join(appRoot,'electron/native-voice-runtime-check.cjs'));
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'voice-packed-probe-'));
 let host;
 try {
  host=await createNativeVoiceHost({appRoot,resourceBundleRoot:bundleRoot,dataDirectory:data,port:43110,readCompanionConfig:()=>({enabled:false,voiceEnabled:false,mockMode:true}),readDevices:()=>({inputName:'probe-not-opened',outputName:'probe-not-opened'}),key:()=>null,
   readConnection:()=>({speechExecution:'local',speechServiceBaseUrl:'local://asr',speechRealtimeRecognitionModel:'zipformer-local',synthesisBaseUrl:'local://tts',synthesisModel:'moss-local',voice:'xiwei-sweet-soft'}),
   // Import/ABI test only. Device-selection acceptance is a separate explicit test.
   verifyRuntime:({appRoot,python})=>verifyNativeVoiceRuntime({appRoot,python})});
  await host.reconcile();
  if(host.control('wake'))throw Error('Disabled host unexpectedly started');
  return {packagedHostLoaded:true,pythonImportsVerified:true,audioDevicesOpened:false,cloudCalls:0};
 }finally{await host?.close();fs.rmSync(data,{recursive:true,force:true})}
}
module.exports={probe};
if(require.main===module)probe(process.argv[2]).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1});
