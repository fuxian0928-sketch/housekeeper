import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
test('public edition retains its identity and never enables personal publication',()=>{
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  assert.equal(pkg.name,'housekeeper');assert.equal(pkg.version,'3.3.0');
  assert.equal(pkg.build.appId,'top.sparkcrate.housekeeper');
  assert.equal(pkg.build.productName,'Housekeeper');assert.equal(pkg.license,'UNLICENSED');
  assert.equal(pkg.scripts['package:win'],'pnpm package:win:local');
  assert.ok(!Object.values(pkg.scripts).some(value=>/publish-windows-release|sync-vault-to-server/.test(value)));
  const main=readFileSync(join(root,'electron/main.cjs'),'utf8');
  assert.match(main,/const DEFAULT_APP_PORT = 43120;/);
  assert.match(main,/app\.getPath\('appData'\), 'housekeeper'/);
  assert.match(main,/app\.getPath\('appData'\), 'housekeeper-runtime'/);
  assert.match(main,/enabled: false,\s+voiceEnabled: false/);
  assert.match(main,/cameraContextEnabled: false/);assert.match(main,/wakeWordEnabled: false/);
});
test('fresh public database has empty connections and no author data',()=>{
  const directory=mkdtempSync(join(tmpdir(),'housekeeper-first-run-'));
  const env={...process.env};for(const key of Object.keys(env))if(/AI_SECRETARY_|API_KEY|OPENAI|TAVILY|DEEPSEEK|DASHSCOPE/.test(key))delete env[key];
  env.AI_SECRETARY_DB_PATH=join(directory,'housekeeper.db');
  const dbUrl=new URL('../server/db.ts',import.meta.url).href;
  const settingsUrl=new URL('../server/domain/settings/settings-service.ts',import.meta.url).href;
  const source=`import {database,initializeDatabase} from ${JSON.stringify(dbUrl)};import {SettingsService} from ${JSON.stringify(settingsUrl)};initializeDatabase();const s=new SettingsService().current();console.log(JSON.stringify({base:s.apiBaseUrl,model:s.model,enabled:s.aiEnabled,key:s.hasApiKey,rows:['messages','projects','tasks','memories','knowledge_documents'].map(t=>database.prepare('SELECT count(*) n FROM '+t).get().n)}));database.close();`;
  const output=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',source],{cwd:root,env,encoding:'utf8'});
  const state=JSON.parse(output.trim().split('\n').at(-1));
  assert.deepEqual(state,{base:'',model:'',enabled:false,key:false,rows:[0,0,0,0,0]});
});
