const test=require('node:test'),assert=require('node:assert/strict');
const {validateNativeVoiceChanges:validate}=require('../../electron/native-voice-settings-validation.cjs');
test('native save rejects invalid timing, rate and volume before normalization',()=>{
 const ranges={voiceMinSpeechMs:[50,500],voiceMaxUtteranceSeconds:[5,30],voiceIdleSeconds:[30,1800],voiceEndSilenceMs:[300,3000],voiceProgressFirstMs:[1000,5000],voiceProgressIntervalMs:[5000,20000],speechVolume:[0,100],voiceSpeechRate:[.5,2],wakeWordThreshold:[.45,.95]};
 for(const [key,[min,max]] of Object.entries(ranges)){
  for(const value of [min,max])assert.doesNotThrow(()=>validate({[key]:value}));
  for(const value of [min-.01,max+.01,NaN,Infinity,null,String(min)])assert.throws(()=>validate({[key]:value}),/未保存/);
 }
 assert.throws(()=>validate({voiceIdleSeconds:300.5}),/整数/);
 assert.doesNotThrow(()=>validate({voiceSpeechRate:1.25}));
 assert.throws(()=>validate({voiceSpeechRate:1.251}),/两位小数/);
});
test('booleans and choices are strict; unrelated companion fields remain untouched',()=>{
 for(const key of ['voiceBargeInEnabled','voicePrefetchEnabled','wakeWordEnabled']){
  for(const value of [true,false])assert.doesNotThrow(()=>validate({[key]:value}));
  for(const value of ['false',0,null])assert.throws(()=>validate({[key]:value}));
 }
 for(const config of [{voicePrefetchAttempts:3},{voiceRoutingMode:'unknown'},{voiceProgressMode:'unknown'},{wakeWord:'x'},null,[]])assert.throws(()=>validate(config));
 const input={appearance:'icon',voiceRoutingMode:'work',voicePrefetchAttempts:1,voiceProgressMode:'off',wakeWord:'小E',speechRate:-3};
 const original=JSON.stringify(input);validate(input);assert.equal(JSON.stringify(input),original);
 assert.doesNotThrow(()=>validate({}));
});
test('save errors never repeat untrusted values',()=>{
 assert.throws(()=>validate({voiceSpeechRate:'private-token-and-path'}),error=>!error.message.includes('private'));
});
