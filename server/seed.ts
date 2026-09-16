import { randomUUID } from 'node:crypto';
import { database, nowIso } from './db.js';

const DEFAULT_VAULT = 'C:\\黑曜石下的资料\\仓库一\\仓库一';

export function seedDatabase() {
  const count = database.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number };
  if (count.count > 0) return;

  const createdAt = nowIso();
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, summary, status, priority, vault_path, source_path, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `);

  const sparkId = randomUUID();
  const agentId = randomUUID();
  insertProject.run(
    sparkId,
    'SparkCrate',
    '验证个人创作者的核心使用闭环。',
    'high',
    DEFAULT_VAULT,
    'SparkCrate产品文档',
    createdAt,
    createdAt
  );
  insertProject.run(
    agentId,
    'Agent 调度中心',
    '稳定本机 Agent 连接、任务调度与重启恢复。',
    'medium',
    DEFAULT_VAULT,
    'Agent调度中心',
    createdAt,
    createdAt
  );

  const insertTask = database.prepare(`
    INSERT INTO tasks (id, project_id, title, description, status, priority, executor, due_at, source_label, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertTask.run(
    randomUUID(), sparkId, '确认 1.1 版本范围',
    '根据 1.0 基线和真实用户验证目标，确认下一版本的最小范围。',
    'todo', 'high', 'self', null, '来自版本基线的后续要求', createdAt, createdAt
  );
  insertTask.run(
    randomUUID(), sparkId, '设计真实用户访谈提纲',
    '围绕热点发现、素材沉淀和 AI 创作闭环设计访谈问题。',
    'doing', 'medium', 'ai', null, '来自产品后续方向', createdAt, createdAt
  );
  insertTask.run(
    randomUUID(), agentId, '梳理 ACP 冷启动稳定性',
    '核对现有 Agent 接入边界和重连策略。',
    'todo', 'high', 'self', null, '来自已知边界', createdAt, createdAt
  );

  const insertMemory = database.prepare(`
    INSERT INTO memories (id, project_id, content, memory_type, status, source_label, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertMemory.run(
    randomUUID(), sparkId,
    'SparkCrate 现阶段优先验证“高质量热点信号 + 个人素材 + AI 创作辅助”的使用闭环。',
    'product_principle', 'confirmed', 'SparkCrate-版本总纲.md > 产品定位', createdAt, createdAt
  );
  insertMemory.run(
    randomUUID(), agentId,
    'Agent 调度中心不保存模型 API Key，账号和模型由各 Agent 自己管理。',
    'technical_constraint', 'confirmed', 'Agent调度中心-需求文档.md > 产品定义', createdAt, createdAt
  );
  insertMemory.run(
    randomUUID(), sparkId,
    '1.1 版本应优先做真实用户验证，不宜继续扩充大量功能。',
    'product_decision', 'candidate', '从需求总文档的后续方向中提取', createdAt, createdAt
  );
}

