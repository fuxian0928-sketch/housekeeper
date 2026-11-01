import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('changing chat provider preserves vision, retrieval and local speech independently',async context=>{
  process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'provider-isolation-')),'test.db');
  const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();context.after(()=>database.close());
  const {SettingsService}=await import('./settings-service.js');
  const vault=()=>{let value:string|null=null;return{load:()=>value,save:(next:string)=>{value=next;},clear:()=>{value=null;}};};
  const chat=vault(),retrieval=vault(),search=vault(),vision=vault();
  const service=new SettingsService(chat,retrieval,search,vision);
  const oldKey='old-provider-test-key-1234567890',newKey='deepseek-test-key-1234567890';
  service.update({apiBaseUrl:'https://old.invalid/v1',apiKey:oldKey,model:'qwen-test',visionModel:'qwen-vision',retrievalApiBaseUrl:'',speechExecution:'local'});
  // The initial empty profile had no credential to preserve. Explicitly follow
  // the original shared connection, as on an existing installation.
  service.update({visionApiBaseUrl:''});
  assert.equal(service.current().visionApiKeySource,'fallback');
  assert.equal(service.current().retrievalApiKeySource,'fallback');
  service.update({apiBaseUrl:'https://api.deepseek.com',apiKey:newKey,model:'deepseek-flash'});
  assert.equal(service.effectiveApiKey(),newKey);
  assert.equal(service.current().visionApiBaseUrl,'https://old.invalid/v1');
  assert.equal(service.effectiveVisionApiKey(),oldKey);
  assert.equal(service.current().retrievalApiBaseUrl,'https://old.invalid/v1');
  assert.equal(service.effectiveRetrievalApiKey(),oldKey);
  assert.equal(service.current().speechExecution,'local');
  assert.equal(service.nativeVoiceConnection().voice,'xiwei-sweet-soft');
  const restarted=new SettingsService(chat,retrieval,search,vision);
  assert.equal(restarted.effectiveVisionApiKey(),oldKey);assert.equal(restarted.effectiveRetrievalApiKey(),oldKey);
  assert.equal(JSON.stringify(restarted.current()).includes(oldKey),false);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE value IN (?,?)").get(oldKey,newKey)?.n,0);
  const before=restarted.current();
  assert.throws(()=>restarted.update({visionApiBaseUrl:'https://user:password@vision.invalid',apiKey:'another-valid-test-key-1234'}));
  assert.equal(restarted.effectiveApiKey(),newKey);assert.deepEqual(restarted.current(),before);
  restarted.update({visionApiBaseUrl:'https://different.invalid/v1',clearVisionApiKey:true});
  assert.equal(restarted.effectiveVisionApiKey(),null,'never send chat key to a different vision host');
  restarted.update({visionApiKey:'new-vision-key-1234567890'});
  assert.equal(restarted.effectiveVisionApiKey(),'new-vision-key-1234567890');
  assert.equal(restarted.effectiveApiKey(),newKey);
});
