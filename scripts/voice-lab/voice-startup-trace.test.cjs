const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createVoiceStartupTrace}=require('../../electron/voice-startup-trace.cjs');

test('startup history identifies the failing phase, strips private metadata, and keeps a bounded history',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-startup-trace-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'logs/startup.json');
 for(let i=0;i<25;i++){
   const trace=createVoiceStartupTrace(file);
   for(const phase of ['settings','resources','runtime','wake','speech-models','audio-device'])trace.mark(phase);
   trace.finish('failed','WORKER_START_TIMEOUT');trace.mark('settings');trace.finish('ready');
 }
 const report=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(report.events.length,128);
 assert.equal(report.events.at(-1).phase,'audio-device');assert.equal(report.events.at(-1).code,'WORKER_START_TIMEOUT');
 report.events.at(-1).secret='PRIVATE';fs.writeFileSync(file,JSON.stringify(report));
 const trace=createVoiceStartupTrace(file);trace.mark('private/path');trace.mark('runtime');trace.finish('failed','PRIVATE/password');
 const next=fs.readFileSync(file,'utf8');assert.ok(!next.includes('PRIVATE'));assert.ok(!next.includes('private/path'));
 const tail=JSON.parse(next).events.at(-1);assert.equal(tail.phase,'runtime');assert.equal('code' in tail,false);
});

test('corrupt old diagnostics and an unwritable location cannot break startup',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-startup-disk-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'startup.json');fs.writeFileSync(file,'not json');
 const trace=createVoiceStartupTrace(file);trace.mark('resources');trace.finish('ready');
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).events.at(-1).status,'ready');
 const blocked=createVoiceStartupTrace(path.join(file,'blocked.json'));
 assert.doesNotThrow(()=>{blocked.mark('settings');blocked.finish('failed','VOICE_SETTINGS_SYNC_FAILED')});
});
