const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createVoiceSecretStore}=require('../../electron/voice-secret-store.cjs');
test('keys are separated, encrypted, replaceable and never returned in status',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-secrets-'));
 const crypto={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).map(n=>n^42),decryptString:b=>Buffer.from(b).map(n=>n^42).toString()};
 const store=createVoiceSecretStore(dir,crypto);
 assert.deepEqual(store.status(),{recognition:'missing',synthesis:'missing'});
 assert.deepEqual(store.save('recognition','test-key'),{recognition:'configured',synthesis:'missing'});
 const firstRevision=store.revisions().recognition;assert.match(firstRevision,/^[a-f0-9]{24}$/);
 assert.equal(store.load('recognition'),'test-key');assert.equal(store.load('synthesis'),null);
 assert.ok(!fs.readFileSync(path.join(dir,'voice-recognition-key.secure'),'utf8').includes('test-key'));
 store.save('recognition','replacement');assert.equal(store.load('recognition'),'replacement');assert.notEqual(store.revisions().recognition,firstRevision);
 assert.throws(()=>store.save('../escape','x'),/PURPOSE/);assert.throws(()=>store.save('synthesis','x\ny'),/INVALID_KEY/);
 crypto.decryptString=()=>{throw Error('unreadable');};assert.equal(store.status().recognition,'unreadable');
 crypto.isEncryptionAvailable=()=>false;assert.throws(()=>store.save('synthesis','x'),/UNAVAILABLE/);
 assert.equal(fs.existsSync(path.join(dir,'voice-synthesis-key.secure')),false);
});
