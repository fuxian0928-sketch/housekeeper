import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

test('内置技能从初始化到按需运行闭环，保留用户选择且不引入选择模型调用', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'xiwei-builtins-'));
  process.env.AI_SECRETARY_DB_PATH = join(directory, 'test.db');
  process.env.AI_SECRETARY_SKILLS_DIR = join(directory, 'skills');
  process.env.AI_SECRETARY_DOCUMENT_ROOT = join(directory, 'raw');
  process.env.AI_SECRETARY_ARTIFACT_ROOT = join(directory, 'artifacts');
  const { database, initializeDatabase, nowIso } = await import('../../db.js');
  initializeDatabase();
  const { bundledSkills, bundledSkillContent } = await import('./bundled-skills.js');
  const { ensureBundledSkills, listManagedSkills, setManagedSkillEnabled, resolveManagedSkillInstructions, buildManagedSkill, uninstallManagedSkill } = await import('./skill-manager.js');
  const { checkBundledSkillHealth, readSkillHealthChecks, checkSkillHealth } = await import('./skill-health.js');
  const { saveToolEnabled, saveToolPolicy } = await import('./tool-controls.js');
  const { agentSkillCatalog, loadAgentSkill } = await import('./agent-skill-loader.js');
  const { skillRequirements } = await import('./skill-requirements.js');
  database.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('assistant_scope','information',?) ON CONFLICT(key) DO UPDATE SET value='information'").run(nowIso());
  context.after(() => {
    database.close();
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  const find = (name: string) => { const skill = listManagedSkills().find(item => item.name === name); assert.ok(skill); return skill; };

  await context.test('启动注册七项规则并检查真实工具依赖，不运行工具或模型', async () => {
    assert.deepEqual(ensureBundledSkills().installed.sort(), bundledSkills.map(skill => skill.name).sort());
    assert.deepEqual(await checkBundledSkillHealth(), []);
    const checks = readSkillHealthChecks();
    for (const definition of bundledSkills) {
      const installed = find(definition.name);
      assert.equal(readFileSync(join(installed.installPath, 'SKILL.md'), 'utf8'), bundledSkillContent(definition));
      assert.equal(installed.manifest.loading, 'on_demand');
      assert.equal(checks.get(installed.id)?.status, 'dependencies_available');
      assert.equal(checks.get(installed.id)?.analysisStatus, 'declared');
      assert.equal(checks.get(installed.id)?.stale, false);
      assert.deepEqual(skillRequirements(installed.id), definition.requiredTools);
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='capability_tool_runs'").get()?.n, 0, '检查不触发工具执行记录表的创建');
    let selected = 0;
    const result = await resolveManagedSkillInstructions('总结文件与我的偏好', async () => { selected++; throw new Error('unnecessary selection model'); });
    assert.equal(selected, 0); assert.equal(result.instruction, '');
    assert.equal(agentSkillCatalog().length, 7);
  });

  await context.test('重复启动不改版本、检查时间或文件，用户停用状态保持', async () => {
    const before = listManagedSkills().map(skill => ({ ...skill, mtime: statSync(join(skill.installPath, 'SKILL.md')).mtimeMs }));
    const checkedAt = readSkillHealthChecks().get(before[0].id)?.checkedAt;
    assert.deepEqual(ensureBundledSkills(), { installed: [], updated: [], skipped: [], errors: [] });
    await checkBundledSkillHealth();
    assert.equal(readSkillHealthChecks().get(before[0].id)?.checkedAt, checkedAt);
    assert.deepEqual(listManagedSkills().map(skill => ({ ...skill, mtime: statSync(join(skill.installPath, 'SKILL.md')).mtimeMs })), before);
    const skill = find('web-research');
    setManagedSkillEnabled(skill.id, false); ensureBundledSkills();
    assert.equal(find(skill.name).enabled, false);
    assert.ok(!agentSkillCatalog().some(item => item.id === skill.id));
    await assert.rejects(() => loadAgentSkill(skill.id), /未启用/);
    setManagedSkillEnabled(skill.id, true);
  });

  await context.test('缺失必需工具会阻止技能加载，可选工具停用不误阻止其他方法', async () => {
    const skill = find('knowledge-recall');
    saveToolEnabled('get_document', false);
    assert.equal(agentSkillCatalog().find(item => item.id === skill.id)?.available, false);
    await assert.rejects(() => loadAgentSkill(skill.id), /get_document/);
    assert.equal((await checkSkillHealth(skill.id)).status, 'blocked');
    assert.equal(find(skill.name).useCount, 0);
    saveToolEnabled('get_document', true);
    saveToolEnabled('forget_memory', false);
    const memory = find('personal-memory');
    const health = await checkSkillHealth(memory.id, async () => { throw new Error('reviewed bundled rules do not require a model'); });
    assert.equal(health.status, 'dependencies_available');
    assert.equal(health.optionalDependencies.find(item => item.name === 'forget_memory')?.enabled, false);
    assert.equal((await loadAgentSkill(memory.id)).name, 'personal-memory');
    saveToolEnabled('forget_memory', true);
  });

  await context.test('旧版 Office 规则升级不重启停用技能，不修改原技能目录', async () => {
    const skill = find('office-document-reader');
    const oldPath = join(directory, 'old-office');
    const { mkdirSync } = await import('node:fs'); mkdirSync(oldPath);
    writeFileSync(join(oldPath, 'SKILL.md'), '保留旧目录作为迁移前资料');
    database.prepare("UPDATE managed_skills SET install_path=?,version='1.0.0',enabled=0,manifest_json='{}' WHERE id=?").run(oldPath, skill.id);
    assert.ok(ensureBundledSkills().updated.includes(skill.name));
    const updated = find(skill.name);
    assert.equal(updated.enabled, false); assert.equal(updated.version, '2.0.0');
    assert.notEqual(updated.installPath, oldPath);
    assert.equal(readFileSync(join(oldPath, 'SKILL.md'), 'utf8'), '保留旧目录作为迁移前资料');
    setManagedSkillEnabled(updated.id, true);
  });

  await context.test('原生 Agent 按目录加载规则、读取真实资料并产出草稿，读取行为可审计', async () => {
    const { createKnowledgeDocument } = await import('../documents/knowledge-document-editor.js');
    const { createAgentRun, listAgentArtifacts, listAgentInvocations } = await import('../agent/run-store.js');
    const { executeOfficeAgent, initialAgentCheckpoint } = await import('../agent/runtime.js');
    const source = createKnowledgeDocument({ title: '内置技能验收资料', content: '已完成需求梳理。预算30万元，待复核。' });
    const conversationId = 'bundled-run', at = nowIso(), goal = '把资料整理成可读摘要';
    database.prepare("INSERT INTO conversations(id,scope_type,title,created_at,updated_at) VALUES(?,'global',?,?,?)").run(conversationId, goal, at, at);
    const run = createAgentRun({ conversationId, projectId: null, inputId: 'builtin-summary', goal, model: 'scripted-test', checkpoint: initialAgentCheckpoint([], goal) }).run;
    let calls = 0;
    const call = (name: string, args: Record<string, unknown>) => ({ content: '', finishReason: 'tool_calls', toolCalls: [{ id: name, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });
    const result = await executeOfficeAgent({ runId: run.id, modelName: 'scripted-test', model: async messages => {
      calls++;
      const system = String(messages.find(message => message.role === 'system')?.content);
      if (calls === 1) {
        assert.match(system, /summary-briefing/);
        assert.doesNotMatch(system, /会议纪要区分已决定、建议、待确认/);
        return call('load_skill', { skillId: find('summary-briefing').id });
      }
      assert.match(system, /会议纪要区分已决定、建议、待确认/);
      if (calls === 2) return call('get_document', { documentId: source.id });
      if (calls === 3) return call('show_draft', { title: '验收摘要', content: '需求梳理已完成。预算30万元，待复核。', sourceDocumentIds: [source.id] });
      return { content: '摘要已展示在页面。预算仍待复核。', finishReason: 'stop', toolCalls: [] };
    } });
    assert.equal(result.run.status, 'completed');
    assert.equal(calls, 4, 'only native tool/answer steps, no separate skill-selector model');
    assert.equal(result.run.checkpoint.skills[0]?.name, 'summary-briefing');
    assert.equal(listAgentInvocations(run.id)[0]?.toolName, 'get_document');
    assert.equal(listAgentArtifacts(run.id)[0]?.content, '需求梳理已完成。预算30万元，待复核。');
    assert.equal(find('summary-briefing').useCount, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM skill_install_events WHERE skill_id=? AND operation='use'").get(find('summary-briefing').id)?.n, 1);
    await assert.rejects(async () => {
      const { executeSkillTool } = await import('./skill-tool-registry.js');
      executeSkillTool('create_document', { title: '不应写入', content: '禁止' }, { vaultPath: 'central://documents' });
    }, /实际执行工作请交给 Codex/);
    saveToolPolicy('save_memory', 'confirm');
    assert.equal((await import('./tool-controls.js')).toolExecutionPolicy('save_memory'), 'confirm');
  });

  await context.test('同名自建技能和明确卸载的内置技能不会被启动覆盖', async () => {
    const skill = find('writing-drafts');
    database.prepare('DELETE FROM managed_skills WHERE id=?').run(skill.id);
    const custom = await buildManagedSkill({ name: skill.name, description: '用户自己的写作方法', instructions: '只使用用户自建规则。' });
    ensureBundledSkills();
    assert.equal(find(skill.name).sourceType, 'local_builder');
    assert.equal(readFileSync(join(custom.installPath, 'SKILL.md'), 'utf8').includes('只使用用户自建规则'), true);
    await uninstallManagedSkill('spreadsheet-insights'); ensureBundledSkills();
    assert.equal(find('spreadsheet-insights').status, 'uninstalled');
  });
});
