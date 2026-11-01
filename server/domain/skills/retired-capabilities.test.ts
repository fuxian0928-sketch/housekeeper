import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('retired prototype capabilities cannot be discovered, loaded or replayed',async t=>{
 process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'retired-capabilities-')),'test.db');
 const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();t.after(()=>database.close());
 const {listSkillTools,getSkillTool,executeSkillTool}=await import('./skill-tool-registry.js');
 const {exposeCapability,defaultAgentCapabilities}=await import('../agent/catalog.js');
 const names=['prototype_capabilities','list_prototypes','get_prototype','create_prototype','update_prototype','patch_prototype','list_prototype_versions'];
 assert.ok(listSkillTools().some(tool=>tool.name==='search_documents'));
 assert.ok(listSkillTools().some(tool=>tool.name==='save_memory'));
 for(const name of names){
  assert.equal(getSkillTool(name),null);
  assert.ok(!listSkillTools().some(tool=>tool.name===name));
  assert.ok(!defaultAgentCapabilities().some(tool=>tool.name===name));
  assert.throws(()=>exposeCapability(name),/停用|移除/);
  await assert.rejects(async()=>executeSkillTool(name,{},{vaultPath:''}),/不存在|不可用|未注册/);
 }
});
