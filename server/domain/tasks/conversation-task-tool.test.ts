import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('conversation task tool validates the whole request, preserves four tasks and dates, and prevents duplicates', async () => {
  process.env.AI_SECRETARY_DB_PATH = join(mkdtempSync(join(tmpdir(), 'conversation-tasks-')), 'test.db');
  const { database, initializeDatabase } = await import('../../db.js');
  const { createConversationTasks } = await import('./conversation-task-tool.js');
  initializeDatabase();
  for (const [id, name] of [['p1','ChatLanguage'],['p2','WPS插件']]) database.prepare("INSERT INTO projects(id,name,vault_path,source_path,created_at,updated_at) VALUES (?,?,'central://documents','','now','now')").run(id,name);
  const drafts = ['翻译语言新增','国际版界面语言新增','入口页面交付开发','新方案给老板看'].map((title,i) => ({title,projectId:i<2?'p1':'p2',description:'详情',priority:'medium' as const,executor:'self' as const,startAt:'2026-09-15T00:00:00+08:00',dueAt:'2026-09-15T23:59:59+08:00'}));
  assert.match(createConversationTasks([...drafts,{...drafts[0],projectId:null}], 'm1'), /哪个项目/);
  assert.equal((database.prepare('SELECT count(*) AS n FROM tasks').get() as {n:number}).n, 0);
  assert.match(createConversationTasks(drafts, 'm2'), /创建 4 个任务/);
  const rows = database.prepare('SELECT project_id,title,start_at,due_at FROM tasks ORDER BY rowid').all() as Array<Record<string,string>>;
  assert.equal(rows.length,4);
  assert.deepEqual(rows.map(r=>r.project_id),['p1','p1','p2','p2']);
  assert.equal(rows[0].start_at,drafts[0].startAt); assert.equal(rows[0].due_at,drafts[0].dueAt);
  assert.match(createConversationTasks(drafts,'m3'), /未重复创建/);
  assert.equal((database.prepare('SELECT count(*) AS n FROM tasks').get() as {n:number}).n,4);
  assert.equal((database.prepare('SELECT count(*) AS n FROM task_history').get() as {n:number}).n,4);
  database.exec("CREATE TRIGGER test_rollback BEFORE INSERT ON tasks WHEN NEW.title='强制失败' BEGIN SELECT RAISE(ABORT,'test'); END;");
  assert.throws(()=>createConversationTasks([{...drafts[0],title:'必须回滚'}, {...drafts[1],title:'强制失败'}],'m4'));
  assert.equal((database.prepare('SELECT count(*) AS n FROM tasks').get() as {n:number}).n,4);
  database.close();
});
