const test=require('node:test'),assert=require('node:assert/strict');
const {displayName,defaultWakeWord,defaultFarewellText,readWakeWord,migrateLegacyIdentityDefaults}=require('../../electron/assistant-identity.cjs');
const {readVoiceFarewell}=require('../../electron/voice-farewell-config.cjs');

test('saved old defaults migrate without resetting device bindings or changing the input',()=>{
 const saved={wakeWord:'小E小E',voiceFarewellText:'那主人继续忙吧，小e先退下啦，有事主人随时叫我哦',microphoneDeviceId:'selected-microphone',inputName:'selected-input',outputName:'selected-output',voiceProjectId:'selected-project',voiceEnabled:false,speechVolume:35};
 const migrated=migrateLegacyIdentityDefaults(saved);
 assert.equal(displayName,'希微');assert.equal(defaultWakeWord,'希微希微');
 assert.equal(migrated.wakeWord,defaultWakeWord);assert.equal(migrated.voiceFarewellText,defaultFarewellText);
 for(const key of ['microphoneDeviceId','inputName','outputName','voiceProjectId','voiceEnabled','speechVolume'])assert.equal(migrated[key],saved[key]);
 assert.equal(saved.wakeWord,'小E小E');assert.notEqual(migrated,saved);
 assert.deepEqual(migrateLegacyIdentityDefaults(migrated),migrated);
 assert.equal(readWakeWord({}),defaultWakeWord);assert.equal(readWakeWord({wakeWord:'小 e 小 E'}),defaultWakeWord);
 assert.equal(readVoiceFarewell(saved).voiceFarewellText,defaultFarewellText);
 assert.match(defaultFarewellText,/主人.*希微/);
});

test('custom wake words and custom farewells remain intact even when they mention the old name',()=>{
 for(const wakeWord of ['你好秘书','小艺','小E','希微','小EE']){
  const saved={wakeWord,voiceFarewellText:'主人，小E今天先休息了。'};
  assert.deepEqual(migrateLegacyIdentityDefaults(saved),saved);
  assert.equal(readWakeWord(saved),wakeWord);
  assert.equal(readVoiceFarewell(saved).voiceFarewellText,saved.voiceFarewellText);
 }
});
