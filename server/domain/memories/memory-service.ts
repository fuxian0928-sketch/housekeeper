import { randomUUID } from 'node:crypto';
import { database, nowIso, sqliteVecAvailable } from '../../db.js';
import type { EmbeddingProvider } from '../../providers/embedding-provider.js';
import { completeProposal } from '../../actions/proposal-service.js';

export type MemoryRow = Record<string, unknown> & { id: string; content: string; project_id: string | null };
const memoryStatuses = new Set(['candidate', 'confirmed', 'superseded', 'invalidated', 'rejected']);
const memoryTypes = new Set(['user_profile', 'preference', 'work_style', 'capability', 'project_fact', 'project_decision', 'project_state', 'procedure', 'decision', 'lesson', 'fact', 'other', 'product_principle', 'technical_constraint', 'product_decision']);

export function mapMemory(row: Record<string, unknown>) {
  return { id: row.id, projectId: row.project_id, projectName: row.project_name, content: row.content, memoryType: row.memory_type, status: row.status, sourceLabel: row.source_label, scopeType: row.scope_type, sourceType: row.source_type, sourceId: row.source_id, sourceExcerpt: row.source_excerpt, validFrom: row.valid_from, validUntil: row.valid_until, supersedesId: row.supersedes_id, contradictsIds: JSON.parse(String(row.contradicts_json ?? '[]')), origin: row.origin ?? 'manual', reason: row.reason ?? '', confidence: Number(row.confidence ?? 1), importance: Number(row.importance ?? row.salience ?? 0.5), evidenceCount: Number(row.evidence_count ?? 1), tags: JSON.parse(String(row.tags_json ?? '[]')), lastVerifiedAt: row.last_verified_at ?? null, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function listMemories(filters: { status?: string | null; projectId?: string | null }) {
  const conditions: string[] = [];
  const parameters: string[] = [];
  if (filters.status && filters.status !== 'all') { conditions.push('m.status = ?'); parameters.push(filters.status); }
  if (filters.projectId) { conditions.push('m.project_id = ?'); parameters.push(filters.projectId); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return (database.prepare(`SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id${where} ORDER BY CASE m.status WHEN 'candidate' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, m.updated_at DESC`).all(...parameters) as Array<Record<string, unknown>>).map(mapMemory);
}

export function listMemorySources(memoryId: string) {
  if (!database.prepare(`SELECT id FROM memories WHERE id = ?`).get(memoryId)) throw httpError('记忆不存在。', 404);
  return database.prepare(`
    SELECT source_type AS sourceType, source_id AS sourceId, source_label AS sourceLabel,
      excerpt, created_at AS createdAt
    FROM memory_sources WHERE memory_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(memoryId);
}

export interface MemoryProjectOverview {
  projectId: string;
  projectName: string;
  memoryCount: number;
  summary: string;
  updatedAt: string | null;
}

export interface MemoryOverview {
  totalCount: number;
  projectSummaries: MemoryProjectOverview[];
  personalSummary: { summary: string; memoryCount: number; updatedAt: string | null };
  generatedAt: string;
}

function readableProjectSummary(project: { summary: string; summary_json: string | null }, memoryContents: string[]) {
  if (project.summary_json) {
    try {
      const value = JSON.parse(project.summary_json) as { narrative?: unknown; headline?: unknown; currentStage?: unknown };
      const narrative = typeof value.narrative === 'string' ? value.narrative.trim() : '';
      const headline = typeof value.headline === 'string' ? value.headline.trim() : '';
      const stage = typeof value.currentStage === 'string' ? value.currentStage.trim() : '';
      if (narrative) return narrative.slice(0, 260);
      if (headline) return `${stage ? `当前处于${stage}。` : ''}${headline}`.slice(0, 260);
    } catch {
      // Older summary rows may contain malformed JSON; fall through to preserved project data.
    }
  }
  if (project.summary.trim()) return project.summary.trim().slice(0, 260);
  if (memoryContents.length) return memoryContents.slice(0, 3).join('；').slice(0, 260);
  return 'AI 还在从这个项目的对话、资料和任务中积累信息。';
}

export function getMemoryOverview(projectId?: string | null): MemoryOverview {
  const timestamp = nowIso();
  const validCondition = `status = 'confirmed' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until >= ?)`;
  const total = database.prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${validCondition}`).get(timestamp, timestamp) as { count: number };
  const projectConditions = projectId ? 'AND p.id = ?' : '';
  const projectParameters = projectId ? [timestamp, timestamp, projectId] : [timestamp, timestamp];
  const projects = database.prepare(`
    SELECT p.id, p.name, p.summary,
      COUNT(m.id) AS memory_count,
      MAX(m.updated_at) AS memory_updated_at,
      (SELECT summary_json FROM project_summary_versions v WHERE v.project_id = p.id ORDER BY v.created_at DESC LIMIT 1) AS summary_json
    FROM projects p
    LEFT JOIN memories m ON m.project_id = p.id AND m.status = 'confirmed'
      AND (m.valid_from IS NULL OR m.valid_from <= ?) AND (m.valid_until IS NULL OR m.valid_until >= ?)
    WHERE p.deleted_at IS NULL ${projectConditions}
    GROUP BY p.id
    ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, p.updated_at DESC
  `).all(...projectParameters) as Array<{ id: string; name: string; summary: string; summary_json: string | null; memory_count: number; memory_updated_at: string | null }>;

  const projectSummaries = projects.map((project) => {
    const memories = database.prepare(`SELECT content FROM memories WHERE project_id = ? AND ${validCondition} ORDER BY importance DESC, updated_at DESC LIMIT 3`).all(project.id, timestamp, timestamp) as Array<{ content: string }>;
    return {
      projectId: project.id,
      projectName: project.name,
      memoryCount: Number(project.memory_count),
      summary: readableProjectSummary(project, memories.map((memory) => memory.content)),
      updatedAt: project.memory_updated_at
    };
  });

  const profileRows = database.prepare(`SELECT field_label, value, updated_at FROM user_profile WHERE trim(value) <> '' ORDER BY updated_at DESC`).all() as Array<{ field_label: string; value: string; updated_at: string }>;
  const personalMemories = database.prepare(`
    SELECT content, updated_at FROM memories
    WHERE project_id IS NULL AND ${validCondition}
      AND memory_type IN ('user_profile', 'preference', 'work_style', 'capability')
    ORDER BY importance DESC, confidence DESC, updated_at DESC LIMIT 8
  `).all(timestamp, timestamp) as Array<{ content: string; updated_at: string }>;
  const personalCount = database.prepare(`
    SELECT COUNT(*) AS count FROM memories
    WHERE project_id IS NULL AND ${validCondition}
      AND memory_type IN ('user_profile', 'preference', 'work_style', 'capability')
  `).get(timestamp, timestamp) as { count: number };
  const personalParts = [
    ...profileRows.map((row) => `${row.field_label}：${row.value}`),
    ...personalMemories.map((memory) => memory.content)
  ].filter((value, index, values) => values.indexOf(value) === index);
  const personalSummary = personalParts.length
    ? personalParts.slice(0, 8).join('；').slice(0, 600)
    : 'AI 还在了解你的偏好、工作方式和长期习惯。';
  const personalUpdatedAt = [...profileRows.map((row) => row.updated_at), ...personalMemories.map((memory) => memory.updated_at)].sort().at(-1) ?? null;

  return {
    totalCount: total.count,
    projectSummaries,
    personalSummary: { summary: personalSummary, memoryCount: personalCount.count, updatedAt: personalUpdatedAt },
    generatedAt: timestamp
  };
}

export interface CreateMemoryInput {
  content?: string; projectId?: string | null; memoryType?: string; sourceLabel?: string; sourceType?: string; sourceId?: string | null; sourceExcerpt?: string;
  validFrom?: string | null; validUntil?: string | null; supersedesId?: string | null; contradictsIds?: string[]; allowRelated?: boolean; suggestionId?: string | null;
}

function httpError(message: string, statusCode: number, details: Record<string, unknown> = {}) { return Object.assign(new Error(message), { statusCode, ...details }); }

export async function createMemory(input: CreateMemoryInput, provider?: EmbeddingProvider | null, signal?: AbortSignal) {
  const content = input.content?.trim() ?? '';
  const memoryType = input.memoryType ?? 'other';
  const sourceLabel = input.sourceLabel?.trim() || '对话记忆';
  if (!content || content.length > 1000 || sourceLabel.length > 200) throw httpError('记忆内容不能为空且最多 1000 字，来源最多 200 字。', 400);
  if (!memoryTypes.has(memoryType)) throw httpError('记忆类型不可用。', 400);
  if (input.projectId && !database.prepare(`SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL`).get(input.projectId)) throw httpError('关联项目不存在。', 404);
  if (input.validFrom && input.validUntil && input.validFrom > input.validUntil) throw httpError('记忆的生效时间不能晚于失效时间。', 400);
  if (input.supersedesId) {
    const replaced = database.prepare(`SELECT project_id FROM memories WHERE id = ? AND status = 'confirmed'`).get(input.supersedesId) as { project_id: string | null } | undefined;
    if (!replaced || (replaced.project_id ?? null) !== (input.projectId ?? null)) throw httpError('要替代的旧记忆不存在、未确认或不属于同一范围。', 409);
  }
  const duplicate = database.prepare(`SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE COALESCE(m.project_id, '') = COALESCE(?, '') AND lower(trim(m.content)) = lower(trim(?)) AND m.status NOT IN ('invalidated', 'rejected') LIMIT 1`).get(input.projectId ?? null, content) as Record<string, unknown> | undefined;
  if (duplicate) {
    if (duplicate.status !== 'confirmed') database.prepare(`UPDATE memories SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?), updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), String(duplicate.id));
    return { memory: mapMemory({ ...duplicate, status: 'confirmed' }), created: false, relatedMemories: [] };
  }
  const contradictsIds = Array.isArray(input.contradictsIds) ? [...new Set(input.contradictsIds.filter((id) => typeof id === 'string'))].slice(0, 20) : [];
  if (contradictsIds.length) {
    const placeholders = contradictsIds.map(() => '?').join(',');
    const relation = database.prepare(`SELECT COUNT(*) AS count FROM memories WHERE id IN (${placeholders}) AND COALESCE(project_id, '') = COALESCE(?, '') AND status = 'confirmed'`).get(...contradictsIds, input.projectId ?? null) as { count: number };
    if (relation.count !== contradictsIds.length) throw httpError('冲突记忆必须是同一范围内的已确认记忆。', 409);
  }
  const relatedMemories = await findRelatedMemories(content, input.projectId ?? null, provider, signal);
  const probableDuplicate = relatedMemories.find((item) => item.relation === 'probable_duplicate');
  if (probableDuplicate && !input.allowRelated && !input.supersedesId && !contradictsIds.length) {
    const existing = database.prepare(`SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?`).get(probableDuplicate.id) as Record<string, unknown>;
    return { memory: mapMemory(existing), created: false, relatedMemories };
  }
  if (input.suggestionId) {
    const suggestion = database.prepare(`SELECT suggestion_type, payload_json, status FROM message_suggestions WHERE id = ?`).get(input.suggestionId) as { suggestion_type: string; payload_json: string; status: string } | undefined;
    const payload = suggestion ? JSON.parse(suggestion.payload_json) as { projectId?: string | null } : null;
    if (suggestion?.status === 'applied') {
      const proposal = database.prepare(`SELECT result_json FROM action_proposals WHERE id = ? AND status = 'succeeded'`).get(input.suggestionId) as { result_json: string | null } | undefined;
      const result = proposal?.result_json ? JSON.parse(proposal.result_json) as { memoryId?: string } : null;
      const existing = result?.memoryId ? database.prepare(`SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?`).get(result.memoryId) as Record<string, unknown> | undefined : undefined;
      if (existing) return { memory: mapMemory(existing), created: false, relatedMemories: [] };
    }
    if (!suggestion || suggestion.suggestion_type !== 'memory' || suggestion.status !== 'pending' || (payload?.projectId ?? null) !== (input.projectId ?? null)) throw httpError('这条记忆建议已处理或不属于当前范围。', 409);
  }
  const id = randomUUID();
  const timestamp = nowIso();
  database.exec('BEGIN');
  try {
    database.prepare(`INSERT INTO memories (id, project_id, content, memory_type, status, source_label, scope_type, source_type, source_id, source_excerpt, valid_from, valid_until, supersedes_id, contradicts_json, confirmed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.projectId ?? null, content, memoryType, sourceLabel, input.projectId ? 'project' : 'global', input.sourceType ?? (input.suggestionId ? 'conversation' : 'manual'), input.sourceId ?? input.suggestionId ?? null, input.sourceExcerpt?.slice(0, 1000) ?? null, input.validFrom ?? null, input.validUntil ?? null, input.supersedesId ?? null, JSON.stringify(contradictsIds), timestamp, timestamp, timestamp);
    syncMemorySearch(id);
    if (input.suggestionId) {
      database.prepare(`UPDATE message_suggestions SET status = 'applied', updated_at = ? WHERE id = ? AND status = 'pending'`).run(timestamp, input.suggestionId);
      completeProposal(input.suggestionId, { memoryId: id, projectId: input.projectId ?? null });
    }
    if (input.projectId) database.prepare(`INSERT INTO events (id, project_id, event_type, object_type, object_id, title, detail, source_type, source_id, created_at) VALUES (?, ?, 'memory_auto_confirmed', 'memory', ?, '已自动记住', ?, ?, ?, ?)`).run(randomUUID(), input.projectId, id, content.slice(0, 120), input.suggestionId ? 'action_proposal' : 'user', input.suggestionId ?? null, timestamp);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  const row = database.prepare(`SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?`).get(id) as Record<string, unknown>;
  return { memory: mapMemory(row), created: true, relatedMemories };
}

export function updateMemory(id: string, body: { content?: string; status?: string; memoryType?: string; validFrom?: string | null; validUntil?: string | null }) {
  const existing = database.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!existing) throw httpError('记忆不存在。', 404);
  const content = (body.content ?? String(existing.content)).trim();
  const status = body.status ?? String(existing.status);
  const memoryType = body.memoryType ?? String(existing.memory_type);
  const validFrom = body.validFrom === undefined ? (existing.valid_from as string | null) : body.validFrom;
  const validUntil = body.validUntil === undefined ? (existing.valid_until as string | null) : body.validUntil;
  if (!content || content.length > 1000 || !memoryStatuses.has(status) || !memoryTypes.has(memoryType) || (validFrom && validUntil && validFrom > validUntil)) throw httpError('请检查记忆内容、状态、类型和有效期。', 400);
  const timestamp = nowIso();
  const confirmedAt = status === 'confirmed' ? (typeof existing.confirmed_at === 'string' ? existing.confirmed_at : timestamp) : existing.confirmed_at;
  const invalidatedAt = ['invalidated', 'rejected', 'superseded'].includes(status) ? timestamp : null;
  database.exec('BEGIN');
  try {
    database.prepare(`UPDATE memories SET content = ?, status = ?, memory_type = ?, valid_from = ?, valid_until = ?, confirmed_at = ?, invalidated_at = ?, updated_at = ? WHERE id = ?`).run(content, status, memoryType, validFrom, validUntil, confirmedAt as string | null, invalidatedAt, timestamp, id);
    if (status === 'confirmed' && typeof existing.supersedes_id === 'string') {
      database.prepare(`UPDATE memories SET status = 'superseded', invalidated_at = ?, updated_at = ? WHERE id = ? AND status = 'confirmed'`).run(timestamp, timestamp, existing.supersedes_id);
      syncMemorySearch(existing.supersedes_id);
    }
    syncMemorySearch(id);
    if (existing.project_id && status !== existing.status) database.prepare(`INSERT INTO events (id, project_id, event_type, object_type, object_id, title, detail, source_type, created_at) VALUES (?, ?, 'memory_status', 'memory', ?, '记忆状态已更新', ?, 'user', ?)`).run(randomUUID(), String(existing.project_id), id, `${String(existing.status)} → ${status}`, timestamp);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { ...mapMemory(database.prepare(`SELECT m.*, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?`).get(id) as Record<string, unknown>), updatedAt: timestamp };
}

function terms(value: string) {
  const normalized = value.toLowerCase();
  const result = new Set(normalized.match(/[a-z0-9_.-]{2,}/g) ?? []);
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) result.add(run);
    for (let index = 0; index < run.length - 1; index += 1) result.add(run.slice(index, index + 2));
  }
  return [...result];
}

function cosine(left: number[], right: number[]) {
  let dot = 0;
  let leftSize = 0;
  let rightSize = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index] * right[index];
    leftSize += left[index] ** 2;
    rightSize += right[index] ** 2;
  }
  return leftSize && rightSize ? dot / Math.sqrt(leftSize * rightSize) : 0;
}

export function lexicalSimilarity(left: string, right: string) {
  const a = new Set(terms(left));
  const b = new Set(terms(right));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / Math.max(a.size, b.size);
}

function ftsQuery(value: string) {
  return terms(value).slice(0, 16).map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

export function syncMemorySearch(memoryId: string) {
  database.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(memoryId);
  const row = database.prepare(`SELECT id, COALESCE(project_id, '') AS project_id, content, source_label FROM memories WHERE id = ?`).get(memoryId) as { id: string; project_id: string; content: string; source_label: string } | undefined;
  if (row) database.prepare(`INSERT INTO memories_fts (memory_id, project_id, content, source_label) VALUES (?, ?, ?, ?)`).run(row.id, row.project_id, row.content, row.source_label);
  if (sqliteVecAvailable) database.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(memoryId);
}

export async function rebuildMemorySemanticIndex(provider: EmbeddingProvider, signal?: AbortSignal, onProgress?: (current: number, total: number) => void) {
  if (!sqliteVecAvailable) throw new Error('当前环境无法加载 sqlite-vec。');
  const rows = database.prepare(`SELECT id, content, memory_type, source_label FROM memories WHERE status = 'confirmed' ORDER BY updated_at DESC`).all() as Array<{ id: string; content: string; memory_type: string; source_label: string }>;
  database.exec('DELETE FROM memory_vectors');
  const insert = database.prepare(`INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)`);
  for (let offset = 0; offset < rows.length; offset += 16) {
    if (signal?.aborted) throw new DOMException('记忆语义索引已停止。', 'AbortError');
    const batch = rows.slice(offset, offset + 16);
    const vectors = await provider.embed(batch.map((row) => `${row.memory_type}\n${row.content}\n来源：${row.source_label}`), signal);
    database.exec('BEGIN');
    try {
      batch.forEach((row, index) => insert.run(row.id, JSON.stringify(vectors[index])));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    onProgress?.(Math.min(offset + batch.length, rows.length), rows.length);
  }
  return { memories: rows.length, model: provider.model, dimension: provider.dimension, version: provider.version };
}

export async function indexSingleMemory(memoryId: string, provider?: EmbeddingProvider | null, signal?: AbortSignal) {
  if (!provider || !sqliteVecAvailable) return false;
  const row = database.prepare(`SELECT content, memory_type, source_label FROM memories WHERE id = ? AND status = 'confirmed'`).get(memoryId) as { content: string; memory_type: string; source_label: string } | undefined;
  if (!row) return false;
  const [vector] = await provider.embed([`${row.memory_type}\n${row.content}\n来源：${row.source_label}`], signal);
  database.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(memoryId);
  database.prepare(`INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)`).run(memoryId, JSON.stringify(vector));
  return true;
}

export async function searchRelevantMemories(query: string, projectId: string, provider?: EmbeddingProvider | null, limit = 8, signal?: AbortSignal) {
  const timestamp = nowIso();
  const eligible = database.prepare(`
    SELECT m.*, p.name AS project_name
    FROM memories m LEFT JOIN projects p ON p.id = m.project_id
    WHERE m.status = 'confirmed' AND (m.project_id = ? OR m.project_id IS NULL)
      AND (m.valid_from IS NULL OR m.valid_from <= ?) AND (m.valid_until IS NULL OR m.valid_until >= ?)
  `).all(projectId, timestamp, timestamp) as MemoryRow[];
  const ranks = new Map<string, number>();
  const queryTerms = terms(query);
  const lexical = eligible.map((row) => ({
    row,
    score: queryTerms.reduce((score, term) => score + (String(row.content).toLowerCase().includes(term) ? 1 : 0), 0) + (row.project_id === projectId ? 2 : 0) + Number(row.salience ?? 0)
  })).sort((a, b) => b.score - a.score);
  lexical.forEach((item, index) => ranks.set(item.row.id, (ranks.get(item.row.id) ?? 0) + 1 / (60 + index + 1)));

  const match = ftsQuery(query);
  if (match) {
    try {
      const fts = database.prepare(`SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT 30`).all(match) as Array<{ memory_id: string }>;
      fts.forEach((row, index) => ranks.set(row.memory_id, (ranks.get(row.memory_id) ?? 0) + 1 / (60 + index + 1)));
    } catch { /* The lexical branch still provides a deterministic fallback. */ }
  }

  if (provider && sqliteVecAvailable) {
    const count = database.prepare(`SELECT COUNT(*) AS count FROM memory_vectors`).get() as { count: number };
    if (count.count) {
      const [vector] = await provider.embed([query], signal);
      const dense = database.prepare(`SELECT memory_id FROM memory_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance`).all(JSON.stringify(vector), Math.min(Math.max(limit * 4, 30), count.count)) as Array<{ memory_id: string }>;
      dense.forEach((row, index) => ranks.set(row.memory_id, (ranks.get(row.memory_id) ?? 0) + 1 / (60 + index + 1)));
    }
  }
  const allowed = new Set(eligible.map((row) => row.id));
  const byId = new Map(eligible.map((row) => [row.id, row]));
  const selected = [...ranks.entries()].filter(([id]) => allowed.has(id)).sort((a, b) => b[1] - a[1]).slice(0, limit).flatMap(([id]) => byId.get(id) ? [byId.get(id)!] : []);
  if (selected.length) {
    const placeholders = selected.map(() => '?').join(',');
    database.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (${placeholders})`).run(timestamp, ...selected.map((row) => row.id));
  }
  return selected;
}

export function getCoreMemorySnapshot(projectId?: string | null, limit = 18) {
  const timestamp = nowIso();
  return database.prepare(`
    SELECT m.*, p.name AS project_name
    FROM memories m LEFT JOIN projects p ON p.id = m.project_id
    WHERE m.status = 'confirmed' AND (m.project_id IS NULL OR m.project_id = ?)
      AND (m.valid_from IS NULL OR m.valid_from <= ?) AND (m.valid_until IS NULL OR m.valid_until >= ?)
      AND (m.memory_type IN ('user_profile', 'preference', 'work_style', 'capability', 'project_decision', 'product_principle', 'technical_constraint', 'procedure') OR m.importance >= 0.78)
    ORDER BY CASE WHEN m.memory_type IN ('user_profile', 'preference', 'work_style') THEN 0 WHEN m.project_id = ? THEN 1 ELSE 2 END,
      m.importance DESC, m.confidence DESC, m.updated_at DESC LIMIT ?
  `).all(projectId ?? null, timestamp, timestamp, projectId ?? null, limit) as MemoryRow[];
}

export async function findRelatedMemories(content: string, projectId: string | null, provider?: EmbeddingProvider | null, signal?: AbortSignal) {
  const candidates = database.prepare(`
    SELECT id, content, memory_type, status, source_label, project_id
    FROM memories WHERE COALESCE(project_id, '') = COALESCE(?, '') AND status NOT IN ('invalidated', 'rejected', 'superseded')
    ORDER BY updated_at DESC LIMIT 50
  `).all(projectId) as MemoryRow[];
  let semantic: number[] = [];
  if (provider && candidates.length) {
    const vectors = await provider.embed([content, ...candidates.map((row) => row.content)], signal);
    semantic = candidates.map((_row, index) => cosine(vectors[0], vectors[index + 1]));
  }
  return candidates.map((row, index) => {
    const lexical = lexicalSimilarity(content, row.content);
    const semanticScore = semantic[index] ?? 0;
    return { id: row.id, content: row.content, status: row.status, memoryType: row.memory_type, sourceLabel: row.source_label, similarity: Math.max(lexical, semanticScore), relation: Math.max(lexical, semanticScore) >= 0.82 ? 'probable_duplicate' : 'related' };
  }).filter((item) => item.similarity >= 0.45).sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}
