const fs=require('node:fs'),path=require('node:path');
function createVoiceEngineSelection({dataDirectory,bundleRoot,forcedNative=false,verifyBundle}) {
 const file=path.join(dataDirectory,'voice-engine.json');let serial=Promise.resolve();
 function requested(){try{return JSON.parse(fs.readFileSync(file,'utf8')).engine==='native'?'native':'legacy'}catch{return bundleRoot&&fs.existsSync(path.join(bundleRoot,'speech-models/xiwei-sweet-soft.json'))?'native':'legacy'}}
 const available=()=>Boolean(bundleRoot&&fs.existsSync(path.join(bundleRoot,'bundle.json')));
 const current=forcedNative||requested()==='native'&&available()?'native':'legacy';
 const status=()=>({current,requested:requested(),available:available(),locked:forcedNative,restartRequired:!forcedNative&&current!==requested()});
 async function inspect(){
   if(!available())return {...status(),available:false};
   try{await verifyBundle(bundleRoot);return {...status(),available:true}}
   catch{return {...status(),available:false}}
 }
 return {current,status,inspect,save(engine){const task=serial.catch(()=>{}).then(async()=>{
   if(forcedNative||!['native','legacy'].includes(engine))throw Error('VOICE_ENGINE_SELECTION_INVALID');
   if(engine==='native'){if(!available())throw Error('VOICE_NATIVE_BUNDLE_MISSING');await verifyBundle(bundleRoot)}
   fs.mkdirSync(dataDirectory,{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify({engine}));fs.renameSync(temp,file);
   return status();
 });serial=task;return task}};
}
function voiceEngineSelectionError(error){
 switch(error?.message){
  case 'VOICE_ENGINE_SELECTION_INVALID':return '当前语音引擎选择不可修改。';
  case 'VOICE_NATIVE_BUNDLE_MISSING':return '当前安装缺少原生语音资源，请修复或重装客户端。';
  case 'VOICE_NATIVE_BUNDLE_INVALID':return '原生语音资源校验失败，请修复或重装客户端。';
  default:return '语音引擎选择未保存，请检查应用数据目录是否可写。';
 }
}
module.exports={createVoiceEngineSelection,voiceEngineSelectionError};
