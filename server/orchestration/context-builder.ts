import { database } from '../db.js';
import { buildProjectOverviewContext, searchKnowledgeDocuments } from '../vault.js';
import { getCoreMemorySnapshot, searchRelevantMemories } from '../domain/memories/memory-service.js';
import type { EmbeddingProvider } from '../providers/embedding-provider.js';
import type { IntentRoute } from './intent-router.js';

export type KnowledgeCitation = { document: string; path: string; excerpt: string };

function cutoff(timeRange: IntentRoute['scope']['timeRange']) {
  const days = timeRange === '24h' ? 1 : timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 14;
  return new Date(Date.now() - days * 86400000).toISOString();
}

export interface ProjectContext {
  blocks: string[];
  citations: KnowledgeCitation[];
  coverage: { documentCount: number; branchCount: number; branches: string[]; citedDocumentCount: number };
  snapshot: Record<string, unknown>;
}

export async function buildProjectContext(projectId: string, query: string, sourcePath: string | null | undefined, route: IntentRoute, embeddingProvider?: EmbeddingProvider | null, signal?: AbortSignal): Promise<ProjectContext> {
  const project = database.prepare(`SELECT id, name, summary, status, priority, source_path, created_at, updated_at FROM projects WHERE id = ? AND deleted_at IS NULL`).get(projectId) as Record<string, unknown> | undefined;
  if (!project) throw new Error('当前项目不存在。');
  const tasks = database.prepare(`SELECT id, title, description, status, priority, executor, due_at, source_label, depends_on_json, blocked_reason, created_at, updated_at, completed_at FROM tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT 80`).all(projectId) as Array<Record<string, unknown>>;
  const currentTasks = tasks.filter((task) => !['done', 'cancelled'].includes(String(task.status))).slice(0, 12);
  const historicalTasks = tasks.filter((task) => ['done', 'cancelled'].includes(String(task.status))).slice(0, 12);
  const history = database.prepare(`SELECT change_type, before_json, after_json, created_at FROM task_history WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`).all(projectId);
  const events = database.prepare(`SELECT event_type, title, detail, object_type, object_id, created_at FROM events WHERE project_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 20`).all(projectId, cutoff(route.scope.timeRange));
  const memories = await searchRelevantMemories(query, projectId, embeddingProvider, 8, signal);
  const coreMemories = getCoreMemorySnapshot(projectId);
  const historicalMemories = route.scope.timeRange === 'history' ? database.prepare(`SELECT content, status, source_label, updated_at FROM memories WHERE project_id = ? AND status IN ('superseded', 'invalidated') ORDER BY updated_at DESC LIMIT 12`).all(projectId) as Array<Record<string, unknown>> : [];
  const relationIds = new Set<string>();
  for (const memory of memories) {
    if (typeof memory.supersedes_id === 'string') relationIds.add(memory.supersedes_id);
    try { for (const id of JSON.parse(String(memory.contradicts_json ?? '[]')) as string[]) relationIds.add(id); } catch { /* malformed legacy relations are ignored */ }
  }
  const relatedMemories = relationIds.size ? database.prepare(`SELECT id, content, status FROM memories WHERE id IN (${[...relationIds].map(() => '?').join(',')})`).all(...relationIds) as Array<Record<string, unknown>> : [];
  const relatedById = new Map(relatedMemories.map((memory) => [String(memory.id), memory]));
  const wantsOverview = route.intents.some((intent) => ['summarize', 'project_status_summary', 'history_trace'].includes(intent.action));
  const overview = buildProjectOverviewContext(sourcePath || null, projectId);
  const semantic = searchKnowledgeDocuments(query, sourcePath || null, wantsOverview ? 10 : 6, projectId).map((item) => ({ document: item.title, path: item.relative_path, excerpt: item.excerpt }));
  const citations: KnowledgeCitation[] = [];
  const seen = new Set<string>();
  for (const citation of [...(wantsOverview ? overview.citations : []), ...semantic]) {
    if (seen.has(citation.path)) continue;
    seen.add(citation.path);
    citations.push(citation);
    if (citations.length >= (wantsOverview ? 14 : 8)) break;
  }

  const lines = (items: Array<Record<string, unknown>>, formatter: (item: Record<string, unknown>, index: number) => string) => items.map(formatter).join('\n') || '无';
  const blocks = [
    `【长期核心记忆（始终遵循）】\n${lines(coreMemories, (memory, index) => `${index + 1}. [${memory.memory_type}] ${memory.content}｜范围：${memory.project_id ? '当前项目' : '用户全局'}｜来源：${memory.source_label || memory.source_type || '未知'}`)}`,
    `【项目身份】\n名称：${project.name}\n目标：${project.summary || '未填写'}\n状态：${project.status}\n优先级：${project.priority}\n资料范围：${project.source_path || '未设置'}\n创建：${project.created_at}\n更新：${project.updated_at}`,
    `【当前任务】\n${lines(currentTasks, (task, index) => `${index + 1}. ${task.title}｜${task.status}｜${task.priority}｜执行方 ${task.executor}${task.due_at ? `｜截止 ${task.due_at}` : ''}${task.depends_on_json && task.depends_on_json !== '[]' ? `｜依赖 ${task.depends_on_json}` : ''}${task.blocked_reason ? `｜阻塞原因 ${task.blocked_reason}` : ''}${task.description ? `\n   ${task.description}` : ''}`)}`,
    `【历史任务】\n${lines(historicalTasks, (task, index) => `${index + 1}. ${task.title}｜${task.status}｜完成/取消于 ${task.completed_at ?? task.updated_at}`)}`,
    `【任务变化历史】\n${lines(history as Array<Record<string, unknown>>, (item, index) => `${index + 1}. ${item.created_at}｜${item.change_type}`)}`,
    `【最近变化】\n${lines(events as Array<Record<string, unknown>>, (event, index) => `${index + 1}. ${event.created_at}｜${event.title}${event.detail ? `：${event.detail}` : ''}`)}`,
    `【当前有效记忆】\n${lines(memories, (memory, index) => {
      const relations: string[] = [];
      if (typeof memory.supersedes_id === 'string' && relatedById.has(memory.supersedes_id)) relations.push(`替代旧记忆“${String(relatedById.get(memory.supersedes_id)?.content)}”`);
      try { for (const id of JSON.parse(String(memory.contradicts_json ?? '[]')) as string[]) if (relatedById.has(id)) relations.push(`与“${String(relatedById.get(id)?.content)}”存在冲突`); } catch { /* malformed legacy relations are ignored */ }
      return `${index + 1}. ${memory.content}｜来源：${memory.source_label || memory.source_type || '未知'}${relations.length ? `｜关系：${relations.join('；')}` : ''}`;
    })}`,
    ...(historicalMemories.length ? [`【历史记忆（不代表当前有效规则）】\n${lines(historicalMemories, (memory, index) => `${index + 1}. [${memory.status}] ${memory.content}｜来源：${memory.source_label || '未知'}｜更新：${memory.updated_at}`)}`] : []),
    `【资料覆盖】\n项目范围共 ${overview.documentCount} 篇文档、${overview.branchCount} 个资料分支；本轮引用 ${citations.length} 篇。分支：${overview.branches.join('、') || '无'}`,
    ...citations.map((citation, index) => `【相关文档 ${index + 1}】${citation.document}\n来源：${citation.path}\n${citation.excerpt}`)
  ];
  return {
    blocks,
    citations,
    coverage: { documentCount: overview.documentCount, branchCount: overview.branchCount, branches: overview.branches, citedDocumentCount: citations.length },
    snapshot: { project, currentTasks, historicalTasks, taskHistory: history, recentEvents: events, coreMemories, memories, historicalMemories, memoryRelations: relatedMemories, coverage: overview }
  };
}
