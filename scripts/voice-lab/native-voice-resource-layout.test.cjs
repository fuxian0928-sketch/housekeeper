const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createNativeVoiceHost} = require('../../electron/native-voice-host.cjs');
const {verifyNativeVoiceRuntime} = require('../../electron/native-voice-runtime-check.cjs');
const root = path.resolve(__dirname, '../..');
const resource = require('../../package.json').build.extraResources.find(row => row.to === 'native-voice/scripts/voice-lab');

test('packaged worker resources contain only the declared runtime files', () => {
  assert.ok(resource);
  for (const file of resource.filter) {
    assert.match(file, /^(?:[a-z_-]+\.(?:py|txt|json)|licenses\/MOSS-TTS-Nano-APACHE-2\.0\.txt)$/);
    assert.ok(!file.startsWith('test_'));
    assert.ok(fs.statSync(path.join(root, resource.from, file)).isFile());
  }
  assert.ok(resource.filter.includes('requirements.txt'));
  assert.ok(resource.filter.includes('model.json'));
  for(const file of ['local_speech_worker.py','moss_ort_runtime.py','local-speech-requirements.txt','licenses/MOSS-TTS-Nano-APACHE-2.0.txt'])assert.ok(resource.filter.includes(file));
});

test('host keeps JS in app root and external worker resources outside asar', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-resource-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const workerRoot = path.join(dir, 'resources', 'native-voice');
  fs.mkdirSync(workerRoot, {recursive:true});
  const appRoot = path.join(dir, 'resources', 'app.asar');
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({python:process.execPath, model:dir, keywords:__filename,inputName:'in',outputName:'out'}));
  const checks = [];
  let worker;
  const host = await createNativeVoiceHost({configFile, appRoot, workerRoot, dataDirectory:dir, port:43110,
    readCompanionConfig:()=>({enabled:false}), key:()=>null,
    prepareKeywords:()=>__filename, verifyAssets:async options=>checks.push(options.appRoot),
    verifyRuntime:async options=>checks.push(options.appRoot),
    loadRuntime:async()=>({createNativeVoiceRuntime(options){worker=options.createWorker(()=>true);return {async close(){}};}})});
  try {
    assert.deepEqual(checks, [workerRoot, workerRoot]);
    assert.equal(worker.options.cwd, workerRoot);
    assert.deepEqual(worker.options.args.slice(0,4), ['-E','-s','-B',path.join(workerRoot,'scripts/voice-lab/run_duplex.py')]);
    assert.ok(!worker.options.args.some(arg=>arg.includes('app.asar')));
  } finally {await host.close();}
});

test('copied resource tree imports the actual worker graph without a source checkout', {skip:!process.env.VOICE_TEST_PYTHON}, async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice packaged resources '));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const destination=path.join(dir,'scripts/voice-lab');fs.mkdirSync(destination,{recursive:true});
  for(const file of resource.filter){const target=path.join(destination,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,resource.from,file),target);}
  assert.deepEqual(await verifyNativeVoiceRuntime({appRoot:dir,python:process.env.VOICE_TEST_PYTHON}),{ready:true});
});
