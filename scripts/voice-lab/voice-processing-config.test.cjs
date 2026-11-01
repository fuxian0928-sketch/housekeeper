const test=require('node:test'),assert=require('node:assert/strict');
const {readVoiceProcessing,voiceProcessingArgs}=require('../../electron/voice-processing-config.cjs');
const {validateNativeVoiceChanges}=require('../../electron/native-voice-settings-validation.cjs');
const {exportPreferences,parsePreferences}=require('../../electron/voice-preference-transfer.cjs');
test('processing defaults preserve existing audio and invalid saved values migrate',()=>{
 assert.deepEqual(voiceProcessingArgs({}),['--echo-delay-ms','44']);
 for(const patch of [{voiceNoiseSuppression:'true'},{voiceAutoGain:1},{voiceEchoDelayMs:251},{voiceEchoDelayMs:1.5}]){assert.throws(()=>validateNativeVoiceChanges(patch));assert.deepEqual(readVoiceProcessing(patch),readVoiceProcessing({}));}
});
test('portable processing preferences reach trusted worker arguments',()=>{
 const preferences=parsePreferences(exportPreferences({voiceNoiseSuppression:true,voiceAutoGain:true,voiceEchoDelayMs:80}));
 assert.deepEqual(voiceProcessingArgs(preferences),['--echo-delay-ms','80','--noise-suppression','--auto-gain']);
});
