import { database, nowIso } from '../../db.js';

export type MemoryContextRequest = {
  query: string;
  // Trusted caller supplies project scope. This is not an authentication mechanism.
  projectIds: readonly string[];
  limit?: number;
  signal?: AbortSignal;
};
export type ContextMemory = {
  memoryId: string; content: string; core: boolean; projectId: string | null;
  memoryType: string; sourceId: string | null; sourceType: string | null;
  sourceLabel: string; sourceExcerpt: string; updatedAt: string;
  validFrom: string | null; validUntil: string | null;
  supersedesId?: string | null; contradictsIds?: string[];
  coreRank?: number; relevantRank?: number;
};
export type MemoryContext = {
  facts: ContextMemory[]; preferences: ContextMemory[]; experiences: ContextMemory[];
  provider: string; retrievedAt: string;
};
export interface MemoryContextProvider {
  retrieve(request: MemoryContextRequest): Promise<MemoryContext>;
}

export function contextMemoryFromRow(row: Record<string, unknown>, core: boolean): ContextMemory {
  const nullable = (value: unknown) => typeof value === 'string' ? value : null;
  let contradictsIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.contradicts_json ?? '[]'));
    if (Array.isArray(parsed)) contradictsIds = [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(0,100);
  } catch { /* Malformed legacy relationship metadata is not an instruction. */ }
  return {
    memoryId: String(row.id), content: String(row.content), core, projectId: nullable(row.project_id),
    memoryType: String(row.memory_type), sourceId: nullable(row.source_id), sourceType: nullable(row.source_type),
    sourceLabel: String(row.source_label ?? ''), sourceExcerpt: String(row.source_excerpt ?? ''),
    updatedAt: String(row.updated_at), validFrom: nullable(row.valid_from), validUntil: nullable(row.valid_until),
    supersedesId: nullable(row.supersedes_id), contradictsIds
  };
}

function searchTokens(value: string) {
  const normalized = value.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
  const tokens = new Set<string>();
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) {
    if (word.length > 1) tokens.add(word);
  }
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return [...tokens];
}


/** Existing confirmed-memory baseline. No extraction, write, model call or emotional inference. */
export class ExistingMemoryContextProvider implements MemoryContextProvider {
  async retrieve(request: MemoryContextRequest): Promise<MemoryContext> {
    request.signal?.throwIfAborted();
    if (request.projectIds.length > 500 || request.projectIds.some(id => typeof id !== 'string' || !id || id.length > 200)) throw Error('MEMORY_SCOPE_INVALID');
    const limit = request.limit ?? 12;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw Error('MEMORY_LIMIT_INVALID');
    const timestamp = nowIso();
    const ids = [...new Set(request.projectIds)];
    const scope = ids.length ? `OR (m.project_id IN (${ids.map(() => '?').join(',')}) AND p.deleted_at IS NULL AND p.id IS NOT NULL)` : '';
    const rows = database.prepare(`SELECT m.*, p.name AS project_name FROM memories m
      LEFT JOIN projects p ON p.id=m.project_id
      WHERE m.status='confirmed' AND (m.project_id IS NULL ${scope})
      AND (m.valid_from IS NULL OR m.valid_from<=?) AND (m.valid_until IS NULL OR m.valid_until>=?)
      ORDER BY m.importance DESC, m.updated_at DESC, m.id`).all(...ids,timestamp,timestamp) as Record<string,unknown>[];
    const tokens = searchTokens(request.query.slice(0,8000));
    const coreTypes = new Set(['user_profile','preference','work_style','capability','project_decision','product_principle','technical_constraint','procedure']);
    const ranked = rows.map(row => {
      const haystack = `${row.content} ${row.source_label} ${row.project_name ?? ''}`.toLowerCase();
      const score = tokens.reduce((sum,token) => sum+(haystack.includes(token)?Math.max(2,token.length):0),0);
      const core = coreTypes.has(String(row.memory_type)) || Number(row.importance)>=0.78;
      return {row,score,core};
    }).filter(item=>item.core || item.score >= (tokens.length===1?2:4))
      .sort((a,b)=>Number(b.core)-Number(a.core)||b.score-a.score||Number(b.row.importance)-Number(a.row.importance)||String(b.row.updated_at).localeCompare(String(a.row.updated_at)))
      .slice(0,limit);
    request.signal?.throwIfAborted();
    const context: MemoryContext = {facts:[],preferences:[],experiences:[],provider:'existing-confirmed-v1',retrievedAt:timestamp};
    for (const {row,core} of ranked) {
      const memory = contextMemoryFromRow(row,core);
      (['preference','work_style'].includes(memory.memoryType)?context.preferences:context.facts).push(memory);
    }
    return context;
  }
}
