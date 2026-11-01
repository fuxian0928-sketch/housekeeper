const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createVoicePreferenceHistory}=require('../../electron/voice-preference-history.cjs');
const {parsePreferences}=require('../../electron/voice-preference-transfer.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'voice-history-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return {directory,store:createVoicePreferenceHistory(directory)}}
test('history survives restart, excludes private config, and restores through ordinary preferences',t=>{
 const {directory,store}=fixture(t);const original={speechVolume:35,apiKey:'secret',voiceProjectId:'private-project',enabled:true};
 store.beforeSave(original,{...original,speechVolume:50});const rows=store.list();assert.equal(rows.length,1);
 const restarted=createVoicePreferenceHistory(directory),text=restarted.get(rows[0].id);
 assert.equal(parsePreferences(text).speechVolume,35);assert.ok(!text.includes('secret'));assert.ok(!text.includes('private-project'));
 const restored={...original,speechVolume:50,...parsePreferences(text)};restarted.beforeSave({...original,speechVolume:50},restored);
 assert.equal(restarted.list().length,2);assert.equal(parsePreferences(restarted.get(restarted.list()[0].id)).speechVolume,50);
});
test('history is bounded and ignores unchanged or retried snapshots',t=>{
 const {store}=fixture(t);store.beforeSave({speechVolume:0},{speechVolume:0});assert.equal(store.list().length,0);
 for(let i=0;i<15;i++)store.beforeSave({speechVolume:i},{speechVolume:i+1});assert.equal(store.list().length,10);
 store.beforeSave({speechVolume:14},{speechVolume:15});assert.equal(store.list().length,10);
 assert.equal(parsePreferences(store.get(store.list()[0].id)).speechVolume,14);
 assert.throws(()=>store.get('../unknown'),/不可用/);
});
test('corrupt or unwritable history fails without overwriting evidence or leaking paths',t=>{
 const {directory,store}=fixture(t),file=path.join(directory,'voice-preference-history.json');fs.writeFileSync(file,'broken');
 assert.throws(()=>store.beforeSave({speechVolume:1},{speechVolume:2}),/无法读取/);assert.equal(fs.readFileSync(file,'utf8'),'broken');
 const blocker=path.join(directory,'private-blocker');fs.writeFileSync(blocker,'file');
 assert.throws(()=>createVoicePreferenceHistory(blocker).beforeSave({speechVolume:1},{speechVolume:2}),error=>error.message.includes('尚未保存')&&!error.message.includes(directory));
});

test('invalid legacy preferences do not block a valid correction and migration is explicit',t=>{
 const {directory,store}=fixture(t);
 const previous={wakeWord:'hey assistant',speechVolume:150,voiceIdleSeconds:24,voiceSpeechRate:1.25,apiKey:'private-key'};
 const next={wakeWord:'小E小E',speechVolume:75,voiceIdleSeconds:300,voiceSpeechRate:1.25};
 store.beforeSave(previous,next);
 const restarted=createVoicePreferenceHistory(directory),rows=restarted.list();
 assert.equal(rows.length,1);
 assert.deepEqual(new Set(rows[0].adjustedLabels),new Set(['唤醒词','播报音量','待机等待秒数']));
 const document=restarted.get(rows[0].id),values=parsePreferences(document);
 assert.equal(values.wakeWord,'希微希微');assert.equal(values.speechVolume,100);
 assert.equal(values.voiceIdleSeconds,300);assert.equal(values.voiceSpeechRate,1.25);
 assert.ok(!fs.readFileSync(path.join(directory,'voice-preference-history.json'),'utf8').includes('private-key'));
 store.beforeSave(previous,next);assert.equal(store.list().length,1);
});

test('migration does not relax new settings validation or hide corrupt migration metadata',t=>{
 const {directory,store}=fixture(t),file=path.join(directory,'voice-preference-history.json');
 assert.throws(()=>store.beforeSave({wakeWord:'invalid'},{wakeWord:'still invalid'}),/唤醒词/);
 assert.equal(fs.existsSync(file),false);
 store.beforeSave({wakeWord:'invalid'},{});
 const data=JSON.parse(fs.readFileSync(file,'utf8'));data.entries[0].adjustedFields=['apiKey'];
 fs.writeFileSync(file,JSON.stringify(data));
 assert.throws(()=>store.list(),/无法读取/);
});

test('default reset preserves unrelated configuration and can be undone through history',t=>{
 const {store}=fixture(t),{defaultPreferences}=require('../../electron/voice-preference-transfer.cjs');
 const previous={voiceSpeechRate:1.25,speechVolume:35,voiceIdleSeconds:600,apiKey:'private-key',voiceProjectId:'project',enabled:false,wakeWordEnabled:false,inputName:'microphone',appearance:'icon'};
 const next={...previous,...parsePreferences(defaultPreferences())};store.beforeSave(previous,next);
 for(const field of ['apiKey','voiceProjectId','enabled','wakeWordEnabled','inputName','appearance'])assert.equal(next[field],previous[field]);
 const restore={...next,...parsePreferences(store.get(store.list()[0].id))};store.beforeSave(next,restore);
 assert.equal(restore.speechVolume,35);assert.equal(restore.voiceSpeechRate,1.25);assert.equal(restore.voiceIdleSeconds,600);
 assert.equal(store.list().length,2);
});
