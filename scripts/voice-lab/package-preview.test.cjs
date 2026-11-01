const test=require('node:test'),assert=require('node:assert/strict');
const {previewConfig,run}=require('./package_preview.cjs');
test('preview copies one complete native bundle and disables publishing',()=>{
 const config=previewConfig('fixture-bundle','fixture-output');
 assert.equal(config.publish,null);assert.equal(config.directories.output,'fixture-output');
 assert.equal(config.extraResources.filter(row=>row.to.startsWith('native-voice')).length,1);
 assert.deepEqual(config.extraResources.find(row=>row.to==='native-voice'),{from:'fixture-bundle',to:'native-voice',filter:['**/*']});
 assert.ok(config.extraResources.some(row=>row.to==='speech-scripts'));
});
test('preview refuses workspace root and locations outside outputs before spawning',async()=>{
 await assert.rejects(run('absent','.'),/new preview directory/);
 await assert.rejects(run('absent','../elsewhere'),/new preview directory/);
 await assert.rejects(run('absent','outputs'),/new preview directory/);
});
const {releaseInputs}=require('./package_native.cjs');
const {verifySourceResources}=require('./package_preview.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
test('native installer requires a bundle and targets only the current user edition version',()=>{
 assert.throws(()=>releaseInputs({}),/sealed, verified/);
 const inputs=releaseInputs({AI_SECRETARY_NATIVE_VOICE_BUNDLE:'fixture'});
 assert.equal(inputs.bundle,path.resolve('fixture'));
 assert.equal(inputs.output,path.resolve('outputs/Housekeeper-v'+require('../../package.json').version));
});
test('installer refuses stale worker files even if an old bundle is internally valid',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'voice-release-source-'));
 try{
  const source=require('../../package.json').build.extraResources.find(row=>row.to==='native-voice/scripts/voice-lab');
  const files=source.filter.map(name=>({path:'scripts/voice-lab/'+name,sha256:createHash('sha256').update(fs.readFileSync(path.resolve(source.from,name))).digest('hex')}));
  files.push({path:'keywords.txt',sha256:createHash('sha256').update(fs.readFileSync(path.resolve('scripts/voice-lab/xiao-e-keywords.txt'))).digest('hex')});
  fs.writeFileSync(path.join(directory,'bundle.json'),JSON.stringify({files}));verifySourceResources(directory);
  files[0].sha256='0'.repeat(64);fs.writeFileSync(path.join(directory,'bundle.json'),JSON.stringify({files}));
  assert.throws(()=>verifySourceResources(directory),/differs from current source/);
 }finally{fs.rmSync(path.join(directory,'bundle.json'));fs.rmdirSync(directory)}
});
