const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {saveJsonAtomically}=require('../../electron/atomic-json-store.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-atomic-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,file:path.join(dir,'config.json')}}
test('first and subsequent saves expose complete JSON and leave no temporary files',t=>{
 const {dir,file}=fixture(t);saveJsonAtomically(file,{speechVolume:50});saveJsonAtomically(file,{speechVolume:75,wakeWord:'小E'});
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{speechVolume:75,wakeWord:'小E'});assert.deepEqual(fs.readdirSync(dir),['config.json']);
});
test('write, flush and replace failures preserve old bytes and remove only owned temp files',t=>{
 const {dir,file}=fixture(t);saveJsonAtomically(file,{speechVolume:35});const old=fs.readFileSync(file);fs.writeFileSync(path.join(dir,'unrelated.tmp'),'keep');
 for(const operation of ['writeFileSync','fsyncSync','renameSync']){
  const io={...fs,[operation](){throw Error('private-path-and-key')}};
  assert.throws(()=>saveJsonAtomically(file,{speechVolume:90},io),error=>!error.message.includes('private')&&error.message.includes('原配置已保留'));
  assert.deepEqual(fs.readFileSync(file),old);assert.deepEqual(fs.readdirSync(dir).sort(),['config.json','unrelated.tmp']);
 }
});
test('serialization failure cannot truncate an existing configuration',t=>{
 const {file}=fixture(t);saveJsonAtomically(file,{speechVolume:35});const input={};input.circular=input;
 assert.throws(()=>saveJsonAtomically(file,input));assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).speechVolume,35);
});
