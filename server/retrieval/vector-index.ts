import { database, nowIso, sqliteVecAvailable } from '../db.js';
import type { EmbeddingProvider } from '../providers/embedding-provider.js';
import { rebuildMemorySemanticIndex } from '../domain/memories/memory-service.js';
import { expandedChunkExcerpt } from '../vault.js';
import { projectDocumentPriorities } from './project-document-priority.js';

export async function rebuildSemanticIndex(provider: EmbeddingProvider, signal?: AbortSignal, onProgress?: (current: number, total: number) => void) {
  if (!sqliteVecAvailable) throw new Error('当前环境无法加载 sqlite-vec。');
  const chunks = database.prepare(`SELECT id, content, heading_path FROM knowledge_chunks ORDER BY document_id, position`).all() as Array<{ id: string; content: string; heading_path: string }>;
  database.exec('DELETE FROM knowledge_vectors');
  const insert = database.prepare(`INSERT INTO knowledge_vectors (chunk_id, embedding) VALUES (?, ?)`);
  const update = database.prepare(`UPDATE knowledge_chunks SET vector_json = ?, embedding_model = ?, embedding_version = ?, indexed_at = ? WHERE id = ?`);
  for (let offset = 0; offset < chunks.length; offset += 16) {
    if (signal?.aborted) throw new DOMException('语义索引已停止。', 'AbortError');
    const batch = chunks.slice(offset, offset + 16);
    const vectors = await provider.embed(batch.map((chunk) => `${chunk.heading_path}\n${chunk.content}`), signal);
    database.exec('BEGIN');
    try {
      batch.forEach((chunk, index) => {
        insert.run(chunk.id, JSON.stringify(vectors[index]));
        update.run(JSON.stringify(vectors[index]), provider.model, provider.version, nowIso(), chunk.id);
      });
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    onProgress?.(Math.min(offset + batch.length, chunks.length), chunks.length);
  }
  const memoryResult = await rebuildMemorySemanticIndex(provider, signal);
  return { chunks: chunks.length, memories: memoryResult.memories, model: provider.model, dimension: provider.dimension, version: provider.version };
}

export async function indexDocumentSemanticVectors(provider: EmbeddingProvider, documentId: string, signal?: AbortSignal) {
  if (!sqliteVecAvailable) return { chunks: 0, skipped: true };
  const chunks = database.prepare(`SELECT id,content,heading_path FROM knowledge_chunks WHERE document_id=? ORDER BY position`).all(documentId) as Array<{ id: string; content: string; heading_path: string }>;
  const remove = database.prepare('DELETE FROM knowledge_vectors WHERE chunk_id=?');
  const insert = database.prepare('INSERT INTO knowledge_vectors(chunk_id,embedding) VALUES(?,?)');
  const update = database.prepare('UPDATE knowledge_chunks SET vector_json=?,embedding_model=?,embedding_version=?,indexed_at=? WHERE id=?');
  for (const chunk of chunks) remove.run(chunk.id);
  for (let offset = 0; offset < chunks.length; offset += 16) {
    if (signal?.aborted) throw new DOMException('语义索引已停止。', 'AbortError');
    const batch = chunks.slice(offset, offset + 16);
    const vectors = await provider.embed(batch.map((chunk) => `${chunk.heading_path}\n${chunk.content}`), signal);
    database.exec('BEGIN');
    try {
      batch.forEach((chunk, index) => {
        insert.run(chunk.id, JSON.stringify(vectors[index]));
        update.run(JSON.stringify(vectors[index]), provider.model, provider.version, nowIso(), chunk.id);
      });
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  return { chunks: chunks.length, skipped: false, model: provider.model, dimension: provider.dimension, version: provider.version };
}

export async function semanticSearch(provider: EmbeddingProvider, query: string, sourcePath: string | null | undefined, limit = 30, signal?: AbortSignal, projectId?: string | null) {
  if (!sqliteVecAvailable) return [];
  const count = database.prepare(`SELECT COUNT(*) AS count FROM knowledge_vectors`).get() as { count: number };
  if (!count.count) return [];
  const [queryVector] = await provider.embed([query], signal);
  const scope = (sourcePath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const priorities = projectId ? projectDocumentPriorities(projectId) : null;
  const rows = database.prepare(`
    SELECT v.chunk_id, v.distance, c.position, c.heading_path, c.content, d.id AS document_id, d.title, d.relative_path
    FROM knowledge_vectors v
    JOIN knowledge_chunks c ON c.id = v.chunk_id
    JOIN knowledge_documents d ON d.id = c.document_id
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
  `).all(JSON.stringify(queryVector), projectId || scope ? count.count : Math.min(count.count, Math.max(limit * 3, 60))) as Array<{ chunk_id: string; distance: number; position: number; heading_path: string; content: string; document_id: string; title: string; relative_path: string }>;
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const score = 1 - row.distance;
    if (score < 0.2) return [];
    if (!projectId && scope && row.relative_path !== scope && !row.relative_path.startsWith(`${scope}/`)) return [];
    if (seen.has(row.document_id)) return [];
    seen.add(row.document_id);
    return [{ documentId: row.document_id, document: row.title, path: row.relative_path, excerpt: expandedChunkExcerpt(row.document_id, row.heading_path, row.position, row.content, 1000), score }];
  }).sort((a, b) => {
    if (priorities) {
      const tierDifference = (priorities.byId.get(a.documentId) ?? 2) - (priorities.byId.get(b.documentId) ?? 2);
      if (tierDifference) return tierDifference;
    }
    return b.score - a.score;
  }).slice(0, limit).map(({ documentId: _documentId, ...item }) => item);
}
