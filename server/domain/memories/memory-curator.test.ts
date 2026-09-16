import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('同类行为先聚合，语义相同的记忆只累计依据而不重复新增', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-secretary-memory-test-'));
  process.env.AI_SECRETARY_DB_PATH = join(directory, 'memory.db');
  const { database, initializeDatabase } = await import('../../db.js');
  const { processPendingObservations, recordMemoryObservation } = await import('./memory-curator.js');
  initializeDatabase();
  context.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

  recordMemoryObservation({ sourceType: 'event', sourceId: 'task-a', sourceLabel: '新建任务', content: '新建任务 A', metadata: { eventType: 'task_created', objectType: 'task' } });
  recordMemoryObservation({ sourceType: 'event', sourceId: 'task-b', sourceLabel: '新建任务', content: '新建任务 B', metadata: { eventType: 'task_created', objectType: 'task' } });
  const grouped = database.prepare(`SELECT occurrence_count AS count FROM memory_observations WHERE dedupe_key <> ''`).get() as { count: number };
  assert.equal(grouped.count, 2);
  assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM memory_observation_sources`).get() as { count: number }).count, 2);

  const complete = async () => JSON.stringify({ memories: [{ action: 'add', content: '用户偏好先确认方案再修改代码', memoryType: 'work_style', scope: 'global', importance: 0.9, confidence: 0.98, reason: '稳定工作方式', autoApply: true }], reflection: '形成稳定工作偏好' });
  recordMemoryObservation({ sourceType: 'onboarding', sourceId: 'profile-style', sourceLabel: '用户介绍', content: '喜欢先确认方案再改代码' });
  await processPendingObservations(complete, null, 20);
  recordMemoryObservation({ sourceType: 'conversation', sourceId: 'conversation-style', sourceLabel: '全局对话', content: '用户：以后都先确认方案再改代码' });
  await processPendingObservations(complete, null, 20);

  const memories = database.prepare(`SELECT status, evidence_count AS evidenceCount, origin FROM memories WHERE content = ?`).all('用户偏好先确认方案再修改代码') as Array<{ status: string; evidenceCount: number; origin: string }>;
  assert.equal(memories.length, 1);
  assert.equal(memories[0].status, 'confirmed');
  assert.equal(memories[0].origin, 'automatic');
  assert.ok(memories[0].evidenceCount >= 2);
});
