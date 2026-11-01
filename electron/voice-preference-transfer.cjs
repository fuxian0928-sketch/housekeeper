const {readVoiceProcessing}=require('./voice-processing-config.cjs');
const {readVoiceFarewell}=require('./voice-farewell-config.cjs');
const {validateNativeVoiceChanges}=require('./native-voice-settings-validation.cjs');
const {readVoiceTiming}=require('./voice-timing-config.cjs');
const {readVoiceProgress}=require('./voice-progress-config.cjs');
const {readVoicePrefetch}=require('./voice-prefetch-config.cjs');
const {readVoiceSynthesis}=require('./voice-synthesis-config.cjs');
const {readWakeWord,migrateLegacyIdentityDefaults}=require('./assistant-identity.cjs');
const labels=Object.freeze({voiceContinuousEnabled:'连续对话',voiceNoiseSuppression:'麦克风降噪',voiceAutoGain:'自动增益',voiceEchoDelayMs:'回声延迟毫秒',voiceFarewellText:'退下提示',voiceMinSpeechMs:'最短有效人声毫秒',wakeWord:'唤醒词',wakeWordThreshold:'唤醒严格程度',speechVolume:'播报音量',voiceSpeechRate:'播报速度',voiceMaxUtteranceSeconds:'单次发言上限',voiceIdleSeconds:'待机等待秒数',voiceEndSilenceMs:'断句等待毫秒',voiceBargeInEnabled:'说话打断',voiceProgressMode:'过程播报模式',voiceProgressFirstMs:'首次提示毫秒',voiceProgressIntervalMs:'提示间隔毫秒',voicePrefetchEnabled:'提前检索记忆',voicePrefetchAttempts:'提前检索次数',voiceRoutingMode:'对话模式'});
function exportPreferences(config){
 const values={...readVoiceProcessing(config),...readVoiceFarewell(config),...readVoiceTiming(config),...readVoiceProgress(config),...readVoicePrefetch(config),...readVoiceSynthesis(config),wakeWord:readWakeWord(config),wakeWordThreshold:config.wakeWordThreshold??.66,speechVolume:config.speechVolume??100,voiceRoutingMode:config.voiceRoutingMode??'life'};
 validateNativeVoiceChanges(values);
 return JSON.stringify({format:'xiaoe-voice-preferences',version:1,preferences:values},null,2);
}
function parsePreferences(text){
 if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>16384)throw Error('配置文件无效或超过16KB。');
 let document;try{document=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw Error('无法读取配置文件，请选择导出的JSON文件。');}
 if(!document||typeof document!=='object'||Array.isArray(document)||document.format!=='xiaoe-voice-preferences'||document.version!==1||Object.keys(document).some(k=>!['format','version','preferences'].includes(k)))throw Error('配置格式或版本不支持，请使用当前版本导出的文件。');
 const values=document.preferences;
 if(!values||typeof values!=='object'||Array.isArray(values)||!Object.keys(values).length||Object.keys(values).some(k=>!Object.hasOwn(labels,k)))throw Error('配置包含不支持的字段；设备、项目、地址和密钥不能通过此文件导入。');
 validateNativeVoiceChanges(values);
 return migrateLegacyIdentityDefaults(values);
}
function previewPreferences(text){return Object.entries(parsePreferences(text)).map(([field,value])=>({field,label:labels[field],value}));}
// History migration only: invalid legacy values must not prevent saving a valid replacement.
function snapshotPreferences(config){
 const defaults=parsePreferences(exportPreferences({})),values={},adjustedFields=[];
 for(const field of Object.keys(labels)){
  if(!Object.hasOwn(config,field))continue;
  try{validateNativeVoiceChanges({[field]:config[field]});values[field]=config[field];}
  catch{values[field]=defaults[field];adjustedFields.push(field);}
 }
 return {document:exportPreferences(values),adjustedFields};
}
function defaultPreferences(){return exportPreferences({});}
module.exports={defaultPreferences,exportPreferences,parsePreferences,previewPreferences,snapshotPreferences,preferenceLabels:labels};
