import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('tool switches are enforced at execution and produce accurate audit records', async () => {
  const directory=mkdtempSync(join(tmpdir(),'tool-controls-'));
  process.env.AI_SECRETARY_DB_PATH=join(directory,'test.db');
  process.env.AI_SECRETARY_SKILLS_DIR=join(directory,'skills');
  const {database,initializeDatabase}=await import('../../db.js'); initializeDatabase();
  const {saveToolEnabled,controlledTool,listToolRuns}=await import('./tool-controls.js');
  const {executeSkillTool,listSkillTools}=await import('./skill-tool-registry.js');
  const {ensureBundledSkills,listManagedSkills,setManagedSkillEnabled}=await import('./skill-manager.js');
  const context={vaultPath:'central://documents'};
  saveToolEnabled('list_projects',false);
  assert.equal(listSkillTools().find(t=>t.name==='list_projects')?.enabled,false);
  assert.throws(()=>executeSkillTool('list_projects',{},context),/停用/);
  saveToolEnabled('list_projects',true);
  assert.ok(Array.isArray(executeSkillTool('list_projects',{},context)));
  saveToolEnabled('create_task',false);
  assert.throws(()=>controlledTool('create_task',()=>assert.fail('direct task path must not run')),/停用/);
  const statuses=(listToolRuns() as Array<{status:string}>).map(r=>r.status);
  assert.deepEqual(statuses,['blocked','succeeded','blocked']);
  ensureBundledSkills();
  const skill=listManagedSkills()[0];setManagedSkillEnabled(skill.id,false);ensureBundledSkills();
  assert.equal(listManagedSkills().find(s=>s.id===skill.id)?.enabled,false);
  database.close();
});
