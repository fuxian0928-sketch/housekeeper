const test=require('node:test'),assert=require('node:assert/strict');
const {exportPreferences,parsePreferences,previewPreferences}=require('../../electron/voice-preference-transfer.cjs');
const document=preferences=>JSON.stringify({format:'xiaoe-voice-preferences',version:1,preferences});
test('export contains only portable preferences and round trips without secrets or bindings',()=>{
 const config={voiceSpeechRate:1.25,speechVolume:35,wakeWord:'小艺',apiKey:'private-key',microphoneDeviceId:'private-device',voiceProjectId:'private-project',synthesisBaseUrl:'private-address',enabled:true,wakeWordEnabled:true};
 const text=exportPreferences(config);assert.ok(!text.includes('private'));assert.ok(!text.includes('wakeWordEnabled'));assert.ok(!text.includes('"enabled"'));
 const parsed=parsePreferences(text);assert.equal(parsed.voiceSpeechRate,1.25);assert.equal(parsed.speechVolume,35);assert.equal(parsed.wakeWord,'小艺');assert.equal(parsed.voicePrefetchEnabled,false);
 assert.deepEqual(parsePreferences('\uFEFF'+text),parsed);assert.equal(previewPreferences(text).length,Object.keys(parsed).length);
});
test('unsupported versions, unknown fields and invalid values fail before an import can be applied',()=>{
 for(const text of ['',null,'x'.repeat(16385),'[]',document({}),document({apiKey:'secret'}),document({voiceProjectId:'project'}),document({voiceSpeechRate:3}),document({voiceBargeInEnabled:'false'}),document({voiceSpeechRate:1}).replace('"version":1','"version":2'),'{"format":"xiaoe-voice-preferences","version":1,"preferences":{"__proto__":{}}}'])assert.throws(()=>parsePreferences(text));
 assert.deepEqual(parsePreferences(document({speechVolume:0})),{speechVolume:0});
});
test('preview is pure and never reflects unknown sensitive field content in errors',()=>{
 const text=document({voiceIdleSeconds:600,voiceRoutingMode:'work'});
 assert.deepEqual(previewPreferences(text),[{field:'voiceIdleSeconds',label:'待机等待秒数',value:600},{field:'voiceRoutingMode',label:'对话模式',value:'work'}]);
 assert.throws(()=>previewPreferences(document({apiKey:'sensitive'})),error=>!error.message.includes('sensitive'));
});

test('defaults are fresh portable preferences and keep speculative retrieval off',()=>{
 const {defaultPreferences}=require('../../electron/voice-preference-transfer.cjs');
 const values=parsePreferences(defaultPreferences());
 assert.equal(Object.keys(values).length,20);
 assert.equal(values.voiceMinSpeechMs,120);assert.equal(values.voiceIdleSeconds,300);assert.equal(values.wakeWord,'希微希微');
 assert.equal(values.voiceSpeechRate,1);assert.equal(values.voicePrefetchEnabled,false);
 for(const field of ['apiKey','enabled','wakeWordEnabled','voiceProjectId','inputName','outputName','appearance'])assert.ok(!Object.hasOwn(values,field));
 values.speechVolume=0;assert.equal(parsePreferences(defaultPreferences()).speechVolume,100);
});

test('farewell preferences validate, migrate and round trip',()=>{
 const {readVoiceFarewell}=require('../../electron/voice-farewell-config.cjs');
 const {validateNativeVoiceChanges}=require('../../electron/native-voice-settings-validation.cjs');
 for(const value of ['',null,123,'a'.repeat(121),'a\nb']){assert.throws(()=>validateNativeVoiceChanges({voiceFarewellText:value}));assert.deepEqual(readVoiceFarewell({voiceFarewellText:value}),readVoiceFarewell({}));}
 assert.equal(parsePreferences(exportPreferences({voiceFarewellText:'下次聊。'})).voiceFarewellText,'下次聊。');
 assert.equal(parsePreferences(document({wakeWord:'小E小E'})).wakeWord,'希微希微');
 assert.equal(parsePreferences(document({voiceFarewellText:'那主人继续忙吧，小e先退下啦，有事主人随时叫我哦'})).voiceFarewellText,'那主人继续忙吧，希微先退下啦，有事主人随时叫我哦');
});
