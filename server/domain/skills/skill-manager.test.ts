import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('本地技能可以构建、自动匹配、覆盖更新并卸载', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-secretary-skill-test-'));
  process.env.AI_SECRETARY_DB_PATH = join(directory, 'skills.db');
  process.env.AI_SECRETARY_SKILLS_DIR = join(directory, 'managed');
  const { database, initializeDatabase } = await import('../../db.js');
  const { buildManagedSkill, listManagedSkills, resolveManagedSkillInstructions, uninstallManagedSkill } = await import('./skill-manager.js');
  const { executeSkillTool } = await import('./skill-tool-registry.js');
  const { runSkillTools } = await import('./skill-executor.js');
  const { confirmAction } = await import('../../actions/action-service.js');
  initializeDatabase();
  context.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

  const created = await buildManagedSkill({ name: 'meeting-summary', description: '把会议记录整理成中文行动项', instructions: '收到会议记录后，列出决定、负责人和下一步。' });
  assert.equal(created.installed, true);
  assert.ok(existsSync(join(created.installPath, 'SKILL.md')));
  mkdirSync(join(created.installPath, 'references'));
  writeFileSync(join(created.installPath, 'references', 'format.md'), '输出必须包含风险登记表。', 'utf8');
  writeFileSync(join(created.installPath, 'SKILL.md'), `${readFileSync(join(created.installPath, 'SKILL.md'), 'utf8')}\n\n参见 [输出格式](references/format.md)。\n`, 'utf8');

  const resolved = await resolveManagedSkillInstructions('请使用 meeting-summary 技能整理这份会议记录');
  assert.equal(resolved.skills[0]?.name, 'meeting-summary');
  assert.match(resolved.instruction, /负责人和下一步/);
  assert.match(resolved.instruction, /风险登记表/);
  const semantic = await resolveManagedSkillInstructions('记一下会议决定', async (input) => {
    const candidate = JSON.parse(input).skills[0];
    assert.match(candidate.usageRules, /负责人和下一步/);
    return JSON.stringify({ skillNames: [candidate.name] });
  });
  assert.equal(semantic.skills[0]?.name, 'meeting-summary');

  const project = executeSkillTool('create_project', { name: '技能测试项目', summary: '验证受控工具' }, { vaultPath: 'central://documents' }) as { id: string };
  const task = executeSkillTool('create_task', { projectId: project.id, title: '验证工具注册中心' }, { vaultPath: 'central://documents' }) as { task: { id: string } };
  assert.ok(task.task.id);
  assert.equal((executeSkillTool('list_project_tasks', { projectId: project.id }, { vaultPath: 'central://documents' }) as unknown[]).length, 1);

  const conversationId = 'skill-test-conversation';
  database.prepare(`INSERT INTO conversations(id,scope_type,project_id,title,created_at,updated_at) VALUES(?, 'project', ?, '技能测试', ?, ?)`).run(conversationId, project.id, new Date().toISOString(), new Date().toISOString());
  const planned = await runSkillTools({
    message: '请新增一条任务', conversationId, skills: resolved.skills, skillInstruction: resolved.instruction,
    context: { projectId: project.id, vaultPath: 'central://documents' },
    complete: async () => JSON.stringify({ toolCalls: [{ skillName: 'meeting-summary', tool: 'create_task', arguments: { title: '等待确认的任务' }, reason: '用户明确要求新增任务' }] })
  });
  assert.equal(planned.pending.length, 1);
  assert.equal((database.prepare(`SELECT status FROM skill_tool_executions WHERE proposal_id=?`).get(planned.pending[0].id) as { status: string }).status, 'pending_confirmation');
  confirmAction(planned.pending[0].id);
  assert.equal((executeSkillTool('list_project_tasks', { projectId: project.id }, { vaultPath: 'central://documents' }) as unknown[]).length, 2);
  assert.equal((database.prepare(`SELECT status FROM skill_tool_executions WHERE proposal_id=?`).get(planned.pending[0].id) as { status: string }).status, 'succeeded');

  const rebuilt = await buildManagedSkill({ name: 'meeting-summary', description: '把会议记录整理成中文行动项', instructions: '新版规则：优先列出决定，再列风险。', replace: true });
  assert.equal(rebuilt.updated, true);
  assert.match(readFileSync(join(rebuilt.installPath, 'SKILL.md'), 'utf8'), /新版规则/);
  assert.equal(listManagedSkills()[0]?.version, '2');

  const removed = await uninstallManagedSkill('meeting-summary');
  assert.equal(removed.removed, true);
  assert.equal(listManagedSkills()[0]?.status, 'uninstalled');
  assert.equal(existsSync(join(directory, 'managed', 'meeting-summary')), false);
});
