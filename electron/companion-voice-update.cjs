// The settings page sends the full companion configuration on every save.
// Only changes used by the native voice runtime should make a save depend on
// the worker being available to apply them immediately.
function requiresVoiceReconcile(before, after) {
  return Object.keys(after).some(key =>
    before[key] !== after[key] &&
    (key === 'voiceEnabled' || key === 'mockMode' || key.startsWith('voice') || key.startsWith('wakeWord'))
  );
}

function restoredVoiceFlags(saved,native){
 const voiceEnabled=typeof saved.voiceEnabled==='boolean'?saved.voiceEnabled:true;
 return {
  // Hiding the desktop avatar and disabling KWS are independent of voice I/O.
  voiceEnabled,
  // The user-facing native voice switch is authoritative. A legacy preview
  // flag must not silently prevent an enabled installation from listening.
  mockMode:native&&voiceEnabled?false:typeof saved.mockMode==='boolean'?saved.mockMode:!native
 };
}
function nativeCompanionSettingsChanges(changes,native){
 if(!native||!changes||typeof changes!=='object'||Array.isArray(changes))return changes;
 // These flags belong to the explicit voice switch IPC, never to a stale
 // appearance/settings draft. Keep legacy hardware calibration compatible.
 const {voiceEnabled:_voiceEnabled,mockMode:_mockMode,...editable}=changes;
 return editable;
}
function migrateNativeVoiceFlags(file,native){
 if(!native)return false;
 try{
  const fs=require('node:fs');
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!saved||typeof saved!=='object'||Array.isArray(saved))return false;
  const flags=restoredVoiceFlags(saved,true);
  if(saved.voiceEnabled===flags.voiceEnabled&&saved.mockMode===flags.mockMode)return false;
  require('./atomic-json-store.cjs').saveJsonAtomically(file,{...saved,...flags});
  return true;
 }catch{return false;} // A read-only or corrupt profile must not prevent startup.
}
function needsCloudVoiceKeys(connection){return connection?.speechExecution!=='local';}
function assertNativeVoiceConnectionReady(settings, readKeyStatus) {
  // An offline speech installation has no cloud speech credentials to unlock.
  if (!needsCloudVoiceKeys(settings)) return;
  const keys = readKeyStatus();
  if (keys.recognition !== 'configured' || keys.synthesis !== 'configured') throw Error('请先在模型连接中配置当前电脑的语音识别和合成密钥。');
  if (!settings.speechServiceBaseUrl || !settings.speechRealtimeRecognitionModel || !settings.speechRealtimeSynthesisBaseUrl || !settings.speechRealtimeSynthesisModel || !settings.speechRealtimeVoice) throw Error('请先在模型连接中补全实时语音识别和合成配置。');
}
module.exports = { requiresVoiceReconcile, restoredVoiceFlags, nativeCompanionSettingsChanges, migrateNativeVoiceFlags, needsCloudVoiceKeys, assertNativeVoiceConnectionReady };
