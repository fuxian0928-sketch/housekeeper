import {retrieveKnowledgeLocal} from './retrieval/rag-service.js';
import {indexRagDocumentById} from './retrieval/rag-store.js';
import { createHash } from 'node:crypto';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join, normalize, relative, resolve } from 'node:path';
import { database, nowIso, sqliteVecAvailable } from './db.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfmTableToMarkdown } from 'mdast-util-gfm-table';
import type { Root, RootContent } from 'mdast';
import { projectDocumentPriorities } from './retrieval/project-document-priority.js';

export interface ScanResult {
  total: number;
  indexed: number;
  chunks: number;
  failed: Array<{ path: string; reason: string }>;
}

export interface ScanProgress {
  stage: 'discovering' | 'reading' | 'cleaning' | 'completed';
  message: string;
  current: number;
  total: number;
  indexed: number;
  chunks: number;
  failed: number;
  path?: string;
}

interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('读取已停止。已完成的文件会保留，下次可以继续。', 'AbortError');
}

async function withInactivityLimit<T>(operation: Promise<T>, label: string, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label}连续 2 分钟没有进展，已跳过。`)), 120000);
    const abort = () => rejectPromise(new DOMException('读取已停止。已完成的文件会保留，下次可以继续。', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    operation.then(resolvePromise, rejectPromise).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  });
}

const headingPattern = /^#\s+(.+)$/m;
const vectorSize = 256;

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.name === '.obsidian' || entry.name.startsWith('.trash') || entryPath.endsWith(join('AI秘书', '设备同步'))) return [];
    if (entry.isDirectory()) return collectMarkdownFiles(entryPath);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [entryPath] : [];
  }));
  return nested.flat();
}

function normalizeRelativePath(value: string) {
  return normalize(value).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function extractTerms(value: string) {
  const normalized = value.toLowerCase().replace(/^---[\s\S]*?---\s*/m, ' ');
  const terms: string[] = normalized.match(/[a-z0-9_.-]{2,}/g) ?? [];
  for (const segment of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (segment.length === 1) terms.push(segment);
    for (let index = 0; index < segment.length - 1; index += 1) terms.push(segment.slice(index, index + 2));
  }
  return terms;
}

function vectorize(value: string) {
  const vector = new Array<number>(vectorSize).fill(0);
  for (const term of extractTerms(value)) {
    const digest = createHash('sha256').update(term).digest();
    const index = digest.readUInt16BE(0) % vectorSize;
    vector[index] += digest[2] % 2 === 0 ? 1 : -1;
  }
  const magnitude = Math.sqrt(vector.reduce((total, item) => total + item * item, 0)) || 1;
  return vector.map((item) => Number((item / magnitude).toFixed(6)));
}

function refreshFts(documentId?: string) {
  if (documentId) database.prepare('DELETE FROM knowledge_chunks_fts WHERE document_id = ?').run(documentId);
  else database.exec('DELETE FROM knowledge_chunks_fts');
  const where = documentId ? 'WHERE c.document_id = ?' : '';
  database.prepare(`
    INSERT INTO knowledge_chunks_fts (chunk_id, document_id, relative_path, title, heading_path, content)
    SELECT c.id, c.document_id, d.relative_path, d.title, c.heading_path, c.content
    FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id ${where}
  `).run(...(documentId ? [documentId] : []));
}

function refreshDocumentRelations() {
  const documents = database.prepare(`SELECT id, relative_path, content, modified_at FROM knowledge_documents`).all() as Array<{ id: string; relative_path: string; content: string; modified_at: string }>;
  const byPath = new Map(documents.map((document) => [document.relative_path.toLowerCase(), document]));
  const byBasename = new Map<string, typeof documents>();
  for (const document of documents) {
    const basename = document.relative_path.split('/').at(-1)?.replace(/\.md$/i, '').toLowerCase() ?? '';
    byBasename.set(basename, [...(byBasename.get(basename) ?? []), document]);
  }
  const resolveTarget = (sourcePath: string, raw: string) => {
    const cleaned = decodeURIComponent(raw).split('#')[0].trim().replace(/\\/g, '/').replace(/^\.\//, '');
    const withExtension = /\.md$/i.test(cleaned) ? cleaned : `${cleaned}.md`;
    const direct = byPath.get(withExtension.toLowerCase());
    if (direct) return direct;
    const sourceFolder = sourcePath.split('/').slice(0, -1).join('/');
    const sibling = byPath.get(`${sourceFolder ? `${sourceFolder}/` : ''}${withExtension}`.toLowerCase());
    if (sibling) return sibling;
    const basename = withExtension.split('/').at(-1)?.replace(/\.md$/i, '').toLowerCase() ?? '';
    const matches = byBasename.get(basename) ?? [];
    return matches.length === 1 ? matches[0] : null;
  };
  database.exec('DELETE FROM knowledge_document_relations');
  const insert = database.prepare(`INSERT OR IGNORE INTO knowledge_document_relations (source_document_id, target_document_id, relation_type, source_text, created_at) VALUES (?, ?, ?, ?, ?)`);
  const timestamp = nowIso();
  for (const document of documents) {
    const targets = [
      ...(document.content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)),
      ...(document.content.matchAll(/\[[^\]]*\]\(([^)]+\.md(?:#[^)]+)?)\)/gi))
    ];
    for (const match of targets) {
      const target = resolveTarget(document.relative_path, match[1]);
      if (target && target.id !== document.id) insert.run(document.id, target.id, 'link', match[0].slice(0, 500), timestamp);
    }
  }
  const versionGroups = new Map<string, typeof documents>();
  for (const document of documents) {
    const key = document.relative_path.toLowerCase().replace(/\.md$/, '').replace(/(?:[-_ ]?(?:v|version|版本)\s*\d+(?:\.\d+)*)$/i, '');
    versionGroups.set(key, [...(versionGroups.get(key) ?? []), document]);
  }
  for (const group of versionGroups.values()) {
    const ordered = group.toSorted((a, b) => b.modified_at.localeCompare(a.modified_at));
    for (let index = 0; index < ordered.length - 1; index += 1) insert.run(ordered[index].id, ordered[index + 1].id, 'version_previous', '按文件版本名与修改时间推断', timestamp);
  }
}

const markdownParser = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm);
const atomicNodeTypes = new Set(['code', 'html', 'table', 'blockquote', 'definition']);

function serializeNode(node: RootContent) {
  if (node.type === 'yaml') return `---\n${node.value}\n---\n`;
  return toMarkdown({ type: 'root', children: [node] } as Root, {
    extensions: [gfmTableToMarkdown()],
    handlers: {
      delete(deleteNode, _parent, state, info) {
        const tracker = state.createTracker(info);
        const opening = tracker.move('~~');
        const content = tracker.move(state.containerPhrasing(deleteNode, { before: opening, after: '~', ...tracker.current() }));
        const closing = tracker.move('~~');
        return opening + content + closing;
      }
    }
  });
}

function estimateTokens(value: string) {
  const han = value.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  const latin = value.match(/[a-zA-Z0-9_]+/g)?.length ?? 0;
  const punctuation = value.match(/[^\s\p{L}\p{N}_]/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(han + latin * 1.25 + punctuation * 0.25));
}

function headingText(node: RootContent) {
  if (node.type !== 'heading') return '';
  return serializeNode(node).replace(/^#{1,6}\s+/, '').trim();
}

export interface MarkdownChunk {
  headingPath: string;
  content: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
  metadata: { nodeTypes: string[]; atomic: boolean; previousPosition: number | null; nextPosition: number | null };
}

export function chunkMarkdown(content: string): MarkdownChunk[] {
  const tree = markdownParser.parse(content) as Root;
  const chunks: MarkdownChunk[] = [];
  const headings: string[] = [];
  let buffered: Array<{ text: string; type: string; start: number; end: number }> = [];
  const push = (items: typeof buffered) => {
    const text = items.map((item) => item.text).join('\n\n').trim();
    if (!text) return;
    chunks.push({ headingPath: headings.filter(Boolean).join(' > '), content: text, startLine: items[0].start, endLine: items.at(-1)?.end ?? items[0].end, tokenCount: estimateTokens(text), metadata: { nodeTypes: [...new Set(items.map((item) => item.type))], atomic: items.length === 1 && atomicNodeTypes.has(items[0].type), previousPosition: null, nextPosition: null } });
  };
  const flush = () => { if (buffered.length) push(buffered); buffered = []; };
  for (const node of tree.children) {
    if (node.type === 'heading') {
      flush();
      headings.splice(node.depth - 1);
      headings[node.depth - 1] = headingText(node);
      continue;
    }
    const text = serializeNode(node).trim();
    if (!text) continue;
    const item = { text, type: node.type, start: node.position?.start.line ?? 1, end: node.position?.end.line ?? node.position?.start.line ?? 1 };
    const itemTokens = estimateTokens(text);
    const bufferedTokens = estimateTokens(buffered.map((entry) => entry.text).join('\n\n'));
    if (atomicNodeTypes.has(node.type)) { flush(); push([item]); continue; }
    if (buffered.length && bufferedTokens + itemTokens > 600) flush();
    buffered.push(item);
    if (estimateTokens(buffered.map((entry) => entry.text).join('\n\n')) >= 420) flush();
  }
  flush();
  if (!chunks.length && content.trim()) chunks.push({ headingPath: '', content: content.trim(), startLine: 1, endLine: content.split(/\r?\n/).length, tokenCount: estimateTokens(content), metadata: { nodeTypes: ['text'], atomic: false, previousPosition: null, nextPosition: null } });
  chunks.forEach((chunk, index) => { chunk.metadata.previousPosition = index > 0 ? index - 1 : null; chunk.metadata.nextPosition = index < chunks.length - 1 ? index + 1 : null; });
  return chunks;
}

export async function scanKnowledgeBase(options: ScanOptions = {}): Promise<ScanResult> {
  options.onProgress?.({ stage: 'discovering', message: '正在查找 Markdown 文件…', current: 0, total: 0, indexed: 0, chunks: 0, failed: 0 });
  throwIfAborted(options.signal);
  const setting = database.prepare(`SELECT value FROM app_settings WHERE key = 'vault_path'`).get() as { value: string } | undefined;
  const configuredPath = setting?.value.trim() ?? '';
  if (!configuredPath) throw new Error('请先在设置中填写 Obsidian Vault 文件夹。');
  const vault = resolve(configuredPath);
  const vaultStat = await withInactivityLimit(stat(vault), '检查 Vault 文件夹时', options.signal);
  if (!vaultStat.isDirectory()) throw new Error('填写的 Obsidian Vault 路径不是文件夹。');
  try {
    await access(join(vault, '.obsidian'));
  } catch {
    throw new Error('这个文件夹不是有效的 Obsidian Vault：没有找到 .obsidian 文件夹。');
  }
  const files = await withInactivityLimit(collectMarkdownFiles(vault), '查找 Markdown 文件时', options.signal);
  const result: ScanResult = { total: files.length, indexed: 0, chunks: 0, failed: [] };
  options.onProgress?.({ stage: 'reading', message: `发现 ${files.length} 篇 Markdown，开始建立索引`, current: 0, total: files.length, indexed: 0, chunks: 0, failed: 0 });
  const indexedAt = nowIso();
  const seenPaths: string[] = [];
  const upsertDocument = database.prepare(`
    INSERT INTO knowledge_documents (id, relative_path, title, excerpt, content, bytes, modified_at, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(relative_path) DO UPDATE SET title = excluded.title, excerpt = excluded.excerpt,
      content = excluded.content, bytes = excluded.bytes, modified_at = excluded.modified_at, indexed_at = excluded.indexed_at
  `);
  const deleteChunks = database.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?');
  const insertChunk = database.prepare(`INSERT INTO knowledge_chunks (id, document_id, position, heading_path, content, vector_json, start_line, end_line, token_count, content_hash, metadata_json, chunking_version, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'markdown-ast-v3', ?)`);
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    throwIfAborted(options.signal);
    const filePath = files[fileIndex];
    const relativePath = normalizeRelativePath(relative(vault, filePath));
    seenPaths.push(relativePath);
    try {
      const fileStat = await withInactivityLimit(stat(filePath), `读取“${relativePath}”时`, options.signal);
      const existingDocument = database.prepare('SELECT id, bytes, modified_at FROM knowledge_documents WHERE relative_path = ?').get(relativePath) as { id: string; bytes: number; modified_at: string } | undefined;
      const existingChunkState = existingDocument ? database.prepare('SELECT COUNT(*) AS count, MIN(chunking_version) AS version FROM knowledge_chunks WHERE document_id = ?').get(existingDocument.id) as { count: number; version: string | null } : { count: 0, version: null };
      const existingChunkCount = existingChunkState.count;
      if (existingDocument && existingDocument.bytes === fileStat.size && existingDocument.modified_at === fileStat.mtime.toISOString() && existingChunkCount > 0 && existingChunkState.version === 'markdown-ast-v3') {
        indexRagDocumentById(existingDocument.id);
        result.indexed += 1;
        result.chunks += existingChunkCount;
        options.onProgress?.({
          stage: 'reading',
          message: `正在处理 ${fileIndex + 1} / ${files.length}`,
          current: fileIndex + 1,
          total: files.length,
          indexed: result.indexed,
          chunks: result.chunks,
          failed: result.failed.length,
          path: relativePath
        });
        continue;
      }
      const content = await withInactivityLimit(readFile(filePath, 'utf8'), `读取“${relativePath}”时`, options.signal);
      const title = content.match(headingPattern)?.[1]?.trim() || relativePath.split('/').at(-1)?.replace(/\.md$/i, '') || '未命名文档';
      const excerpt = content.replace(/^---[\s\S]*?---\s*/m, '').replace(/^#{1,6}\s+/gm, '').replace(/[`*_>|\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
      const documentId = existingDocument?.id ?? createHash('sha256').update(relativePath).digest('hex').slice(0, 24);
      const chunks = chunkMarkdown(content);
      database.exec('BEGIN');
      try {
        upsertDocument.run(documentId, relativePath, title, excerpt, content, fileStat.size, fileStat.mtime.toISOString(), indexedAt);
        deleteChunks.run(documentId);
        chunks.forEach((chunk, position) => {
          const chunkId = createHash('sha256').update(`${documentId}:${position}:${chunk.content}`).digest('hex').slice(0, 24);
          insertChunk.run(chunkId, documentId, position, chunk.headingPath, chunk.content, JSON.stringify(vectorize(`${title}\n${chunk.headingPath}\n${chunk.content}`)), chunk.startLine, chunk.endLine, chunk.tokenCount, createHash('sha256').update(chunk.content).digest('hex'), JSON.stringify(chunk.metadata), indexedAt);
        });
        indexRagDocumentById(documentId);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      result.indexed += 1;
      result.chunks += chunks.length;
    } catch (error) {
      result.failed.push({ path: relativePath, reason: error instanceof Error ? error.message : '未知错误' });
    }
    options.onProgress?.({
      stage: 'reading',
      message: `正在处理 ${fileIndex + 1} / ${files.length}`,
      current: fileIndex + 1,
      total: files.length,
      indexed: result.indexed,
      chunks: result.chunks,
      failed: result.failed.length,
      path: relativePath
    });
  }
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: 'cleaning', message: '正在核对已删除或移动的文件…', current: files.length, total: files.length, indexed: result.indexed, chunks: result.chunks, failed: result.failed.length });
  const seen = new Set(seenPaths);
  const existing = database.prepare('SELECT relative_path FROM knowledge_documents').all() as Array<{ relative_path: string }>;
  const remove = database.prepare('DELETE FROM knowledge_documents WHERE relative_path = ?');
  database.exec('BEGIN');
  try {
    for (const item of existing) if (!seen.has(item.relative_path)) remove.run(item.relative_path);
    refreshFts();
    refreshDocumentRelations();
    database.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('vault_last_scanned_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(indexedAt, indexedAt);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  options.onProgress?.({ stage: 'completed', message: '资料库更新完成', current: files.length, total: files.length, indexed: result.indexed, chunks: result.chunks, failed: result.failed.length });
  return result;
}

export function indexKnowledgeContent(input: { relativePath: string; content: string; modifiedAt: string; bytes?: number; title?: string }) {
  const relativePath = normalizeRelativePath(input.relativePath);
  if (!relativePath || relativePath === '.' || !relativePath.toLowerCase().endsWith('.md')) throw new Error('只能索引有效的 Markdown 相对路径。');
  const content = input.content;
  const title = input.title?.trim() || content.match(headingPattern)?.[1]?.trim() || relativePath.split('/').at(-1)?.replace(/\.md$/i, '') || '未命名文档';
  const excerpt = content.replace(/^---[\s\S]*?---\s*/m, '').replace(/^#{1,6}\s+/gm, '').replace(/[`*_>|\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const indexedAt = nowIso();
  const existing = database.prepare('SELECT id,content,title FROM knowledge_documents WHERE relative_path = ?').get(relativePath) as { id: string; content: string; title:string } | undefined;
  const documentId = existing?.id ?? createHash('sha256').update(relativePath).digest('hex').slice(0, 24);
  if (existing?.content === content && existing.title === title) {
    const chunkCount = Number((database.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE document_id = ?').get(documentId) as { count: number }).count);
    database.prepare('UPDATE knowledge_documents SET bytes=?,modified_at=?,indexed_at=? WHERE id=?').run(input.bytes ?? Buffer.byteLength(content, 'utf8'), input.modifiedAt, indexedAt, documentId);
    indexRagDocumentById(documentId);
    return { documentId, relativePath, title, chunks: chunkCount, indexedAt, reused: true };
  }
  const oldChunkIds = existing ? (database.prepare('SELECT id FROM knowledge_chunks WHERE document_id = ?').all(documentId) as Array<{ id: string }>).map((row) => row.id) : [];
  const chunks = chunkMarkdown(content);
  database.exec('SAVEPOINT knowledge_index_update');
  try {
    if (sqliteVecAvailable && oldChunkIds.length) {
      const removeVector = database.prepare('DELETE FROM knowledge_vectors WHERE chunk_id = ?');
      for (const chunkId of oldChunkIds) removeVector.run(chunkId);
    }
    database.prepare(`
      INSERT INTO knowledge_documents (id, relative_path, title, excerpt, content, bytes, modified_at, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(relative_path) DO UPDATE SET title = excluded.title, excerpt = excluded.excerpt,
        content = excluded.content, bytes = excluded.bytes, modified_at = excluded.modified_at, indexed_at = excluded.indexed_at
    `).run(documentId, relativePath, title, excerpt, content, input.bytes ?? Buffer.byteLength(content, 'utf8'), input.modifiedAt, indexedAt);
    database.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(documentId);
    const insertChunk = database.prepare(`INSERT INTO knowledge_chunks (id, document_id, position, heading_path, content, vector_json, start_line, end_line, token_count, content_hash, metadata_json, chunking_version, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'markdown-ast-v3', ?)`);
    chunks.forEach((chunk, position) => {
      const chunkId = createHash('sha256').update(`${documentId}:${position}:${chunk.content}`).digest('hex').slice(0, 24);
      insertChunk.run(chunkId, documentId, position, chunk.headingPath, chunk.content, JSON.stringify(vectorize(`${title}\n${chunk.headingPath}\n${chunk.content}`)), chunk.startLine, chunk.endLine, chunk.tokenCount, createHash('sha256').update(chunk.content).digest('hex'), JSON.stringify(chunk.metadata), indexedAt);
    });
    refreshFts();
    refreshDocumentRelations();
    indexRagDocumentById(documentId);
    database.exec('RELEASE SAVEPOINT knowledge_index_update');
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT knowledge_index_update; RELEASE SAVEPOINT knowledge_index_update');
    throw error;
  }
  return { documentId, relativePath, title, chunks: chunks.length, indexedAt, reused: false };
}

export function removeKnowledgeContent(relativePathInput: string) {
  const relativePath = normalizeRelativePath(relativePathInput);
  const existing = database.prepare('SELECT id FROM knowledge_documents WHERE relative_path=?').get(relativePath) as { id: string } | undefined;
  if (!existing) return false;
  const chunkIds = (database.prepare('SELECT id FROM knowledge_chunks WHERE document_id=?').all(existing.id) as Array<{ id: string }>).map((row) => row.id);
  database.exec('BEGIN');
  try {
    if (sqliteVecAvailable && chunkIds.length) {
      const removeVector = database.prepare('DELETE FROM knowledge_vectors WHERE chunk_id=?');
      for (const chunkId of chunkIds) removeVector.run(chunkId);
    }
    database.prepare('DELETE FROM knowledge_documents WHERE id=?').run(existing.id);
    refreshFts();
    refreshDocumentRelations();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return true;
}

function scopeMatches(relativePath: string, sourcePath?: string | null) {
  const scope = normalizeRelativePath(sourcePath?.trim() || '.');
  return !scope || scope === '.' || relativePath === scope || relativePath.startsWith(`${scope}/`);
}

export function listKnowledgeDocuments(sourcePath?: string | null) {
  const rows = database.prepare(`SELECT id, relative_path AS relativePath, title, excerpt, bytes, modified_at AS modifiedAt, indexed_at AS indexedAt FROM knowledge_documents ORDER BY modified_at DESC`).all() as Array<Record<string, unknown> & { relativePath: string }>;
  return rows.filter((row) => scopeMatches(row.relativePath, sourcePath));
}

export function countKnowledgeDocuments(sourcePath?: string | null) {
  return sourcePath?.trim() ? listKnowledgeDocuments(sourcePath).length : 0;
}

export function expandedChunkExcerpt(documentId: string, headingPath: string, position: number, content: string, limit = 900) {
  const parentPath = headingPath.split(' > ').slice(0, -1).join(' > ');
  const parent = parentPath ? database.prepare(`SELECT heading_path, content FROM knowledge_chunks WHERE document_id = ? AND heading_path = ? AND position < ? ORDER BY position DESC LIMIT 1`).get(documentId, parentPath, position) as { heading_path: string; content: string } | undefined : undefined;
  const adjacent = database.prepare(`SELECT heading_path, content FROM knowledge_chunks WHERE document_id = ? AND position = ? AND heading_path = ?`).get(documentId, position - 1, headingPath) as { heading_path: string; content: string } | undefined;
  return [parent ? `父节：${parent.heading_path}\n${parent.content}` : '', adjacent ? `相邻内容：${adjacent.content}` : '', `${headingPath ? `${headingPath}\n` : ''}${content}`].filter(Boolean).join('\n\n').slice(0, limit);
}

export function legacySearchKnowledgeDocuments(query: string, sourcePath?: string | null, limit = 4, projectId?: string | null) {
  const priorities = projectId ? projectDocumentPriorities(projectId) : null;
  const inRetrievalScope = (documentId: string, relativePath: string) => projectId
    ? priorities?.byId.has(documentId) === true
    : scopeMatches(relativePath, sourcePath);
  const queryVector = vectorize(query);
  const rows = database.prepare(`SELECT c.position, c.heading_path, c.content, c.vector_json, d.id AS document_id, d.title, d.relative_path FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id`).all() as Array<{ position: number; heading_path: string; content: string; vector_json: string; document_id: string; title: string; relative_path: string }>;
  type RankedDocument = { id: string; title: string; relative_path: string; excerpt: string; score: number; headingPath?: string; position?: number };
  const bestByDocument = new Map<string, RankedDocument>();
  for (const row of rows) {
    if (!inRetrievalScope(row.document_id, row.relative_path)) continue;
    const savedVector = JSON.parse(row.vector_json) as number[];
    const vector = savedVector.length===vectorSize?savedVector:vectorize(`${row.title}\n${row.heading_path}\n${row.content}`);
    const score = vector.reduce((total, value, index) => total + value * (queryVector[index] ?? 0), 0);
    const current = bestByDocument.get(row.document_id);
    if (!current || score > current.score) bestByDocument.set(row.document_id, { id: row.document_id, title: row.title, relative_path: row.relative_path, excerpt: row.content, score, headingPath: row.heading_path, position: row.position });
  }
  const dense = [...bestByDocument.values()].filter((item) => item.score >= 0.08).sort((a, b) => b.score - a.score).slice(0, Math.max(limit * 6, 30));
  const lexical: RankedDocument[] = [];
  const ftsTerms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_.-]{2,}/gu) ?? []).slice(0, 12))];
  if (ftsTerms.length) {
    try {
      const match = ftsTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      const ftsRows = database.prepare(`SELECT document_id, relative_path, title, heading_path, content, (SELECT position FROM knowledge_chunks c WHERE c.id = knowledge_chunks_fts.chunk_id) AS position, bm25(knowledge_chunks_fts, 0, 0, 0, 3, 1, 1) AS rank FROM knowledge_chunks_fts WHERE knowledge_chunks_fts MATCH ? ORDER BY rank LIMIT 60`).all(match) as Array<{ document_id: string; relative_path: string; title: string; heading_path: string; content: string; position: number; rank: number }>;
      const seenDocuments = new Set<string>();
      for (const row of ftsRows) {
        if (seenDocuments.has(row.document_id) || !inRetrievalScope(row.document_id, row.relative_path)) continue;
        seenDocuments.add(row.document_id);
        lexical.push({ id: row.document_id, title: row.title, relative_path: row.relative_path, excerpt: row.content, score: -row.rank, headingPath: row.heading_path, position: row.position });
      }
    } catch {
      // FTS is a degradation path: malformed queries or unavailable FTS fall back to dense hashing.
    }
  }
  const fused = new Map<string, { item: typeof dense[number]; score: number }>();
  lexical.forEach((item, rank) => fused.set(item.id, { item, score: 1 / (60 + rank + 1) }));
  dense.forEach((item, rank) => {
    const current = fused.get(item.id);
    fused.set(item.id, { item: current?.item ?? item, score: (current?.score ?? 0) + 1 / (60 + rank + 1) });
  });
  const primary = [...fused.values()].sort((a, b) => b.score - a.score);
  const expanded = new Map(primary.map(({ item, score }) => [item.id, { ...item, score }]));
  const seedIds = primary.slice(0, Math.min(limit, 8)).map(({ item }) => item.id);
  if (seedIds.length) {
    const placeholders = seedIds.map(() => '?').join(',');
    const related = database.prepare(`
      SELECT r.source_document_id, r.target_document_id, r.relation_type,
        d.id, d.title, d.relative_path,
        (SELECT CASE WHEN c.heading_path <> '' THEN c.heading_path || char(10) || c.content ELSE c.content END FROM knowledge_chunks c WHERE c.document_id = d.id ORDER BY c.position LIMIT 1) AS excerpt
      FROM knowledge_document_relations r
      JOIN knowledge_documents d ON d.id = CASE WHEN r.source_document_id IN (${placeholders}) THEN r.target_document_id ELSE r.source_document_id END
      WHERE r.source_document_id IN (${placeholders}) OR r.target_document_id IN (${placeholders})
    `).all(...seedIds, ...seedIds, ...seedIds) as Array<{ source_document_id: string; target_document_id: string; relation_type: string; id: string; title: string; relative_path: string; excerpt: string }>;
    related.forEach((item, index) => {
      if (expanded.has(item.id) || !inRetrievalScope(item.id, item.relative_path)) return;
      expanded.set(item.id, { id: item.id, title: item.title, relative_path: item.relative_path, excerpt: `关联资料（${item.relation_type === 'version_previous' ? '历史版本' : '文档链接'}）\n${item.excerpt ?? ''}`.slice(0, 700), score: 1 / (120 + index + 1) });
    });
  }
  return [...expanded.values()].sort((a, b) => {
    if (priorities) {
      const tierDifference = (priorities.byId.get(a.id) ?? 2) - (priorities.byId.get(b.id) ?? 2);
      if (tierDifference) return tierDifference;
    }
    return b.score - a.score;
  }).slice(0, limit).map(({ headingPath = '', position = 0, ...item }) => ({ ...item, excerpt: expandedChunkExcerpt(item.id, headingPath, position, item.excerpt, 900) }));
}

const overviewHeadingPattern = /(?:项目背景|背景|项目情况|项目介绍|相关信息|基本信息|简介|概况|最终输出|最终交付|交付物|成果|关键结论|主要结论|管理摘要|项目范围|版本说明|总结|进展)/i;
const overviewDocumentPattern = /(?:背景|项目情况|项目介绍|相关信息|基本信息|简介|概况|总览|索引|摘要|报告|总结|复盘|成果|交付)/i;

function scopedBranch(relativePath: string, sourcePath?: string | null) {
  const scope = normalizeRelativePath(sourcePath?.trim() || '.');
  const remainder = scope && scope !== '.' && relativePath.startsWith(`${scope}/`) ? relativePath.slice(scope.length + 1) : relativePath;
  const parts = remainder.split('/');
  return parts.length > 1 ? parts[0] : '根目录';
}

export function buildProjectOverviewContext(sourcePath?: string | null, projectId?: string | null) {
  const documents = database.prepare(`SELECT id, relative_path, title FROM knowledge_documents ORDER BY relative_path`).all() as Array<{ id: string; relative_path: string; title: string }>;
  const priorities = projectId ? projectDocumentPriorities(projectId) : null;
  const linkedDocuments = priorities ? documents.filter((document) => priorities.byId.get(document.id) === 0) : [];
  const scopedDocuments = linkedDocuments.length ? linkedDocuments : documents.filter((document) => scopeMatches(document.relative_path, sourcePath));
  const scopedDocumentIds = new Set(scopedDocuments.map((document) => document.id));
  const branches = [...new Set(scopedDocuments.map((document) => scopedBranch(document.relative_path, sourcePath)))];
  const rows = database.prepare(`
    SELECT c.document_id, c.heading_path, c.content, d.title, d.relative_path
    FROM knowledge_chunks c
    JOIN knowledge_documents d ON d.id = c.document_id
  `).all() as Array<{ document_id: string; heading_path: string; content: string; title: string; relative_path: string }>;
  const candidates = rows.flatMap((row) => {
    if (!scopedDocumentIds.has(row.document_id)) return [];
    const headingMatch = overviewHeadingPattern.test(row.heading_path);
    const documentMatch = overviewDocumentPattern.test(row.title) || overviewDocumentPattern.test(row.relative_path);
    if (!headingMatch && !documentMatch) return [];
    const score = (headingMatch ? 4 : 0) + (/(?:总览|索引)/i.test(row.title) ? 3 : 0) + (/(?:最终输出|交付物|成果|关键结论)/i.test(row.heading_path) ? 3 : 0);
    return [{
      document: row.title,
      path: row.relative_path,
      excerpt: `${row.heading_path ? `${row.heading_path}\n` : ''}${row.content}`.slice(0, 1200),
      branch: scopedBranch(row.relative_path, sourcePath),
      score
    }];
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'zh-CN'));
  const selected: typeof candidates = [];
  const selectedPaths = new Set<string>();
  for (const branch of branches) {
    const candidate = candidates.find((item) => item.branch === branch && !selectedPaths.has(item.path));
    if (!candidate) continue;
    selected.push(candidate);
    selectedPaths.add(candidate.path);
  }
  for (const candidate of candidates) {
    if (selected.length >= 14) break;
    if (selectedPaths.has(candidate.path)) continue;
    selected.push(candidate);
    selectedPaths.add(candidate.path);
  }
  const directory = scopedDocuments.map((document) => `- [${scopedBranch(document.relative_path, sourcePath)}] ${document.title}｜${document.relative_path}`).join('\n');
  return {
    documentCount: scopedDocuments.length,
    branchCount: branches.length,
    branches,
    directory,
    citations: selected.map(({ document, path, excerpt }) => ({ document, path, excerpt }))
  };
}

export async function reindexKnowledgeDocument(relativePathInput: string) {
  const setting = database.prepare(`SELECT value FROM app_settings WHERE key = 'vault_path'`).get() as { value: string } | undefined;
  const configuredPath = setting?.value.trim() ?? '';
  if (!configuredPath) throw new Error('请先在设置中填写 Obsidian Vault 文件夹。');
  const vault = resolve(configuredPath);
  const relativePath = normalizeRelativePath(relativePathInput);
  const filePath = resolve(vault, relativePath);
  const pathFromVault = normalizeRelativePath(relative(vault, filePath));
  if (!relativePath || pathFromVault.startsWith('../') || pathFromVault === '..') throw new Error('目标文件不在当前 Obsidian Vault 中。');
  const fileStat = await stat(filePath);
  const content = await readFile(filePath, 'utf8');
  const indexedAt = nowIso();
  const title = content.match(headingPattern)?.[1]?.trim() || relativePath.split('/').at(-1)?.replace(/\.md$/i, '') || '未命名文档';
  const excerpt = content.replace(/^---[\s\S]*?---\s*/m, '').replace(/^#{1,6}\s+/gm, '').replace(/[`*_>|\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const existing = database.prepare('SELECT id FROM knowledge_documents WHERE relative_path = ?').get(relativePath) as { id: string } | undefined;
  const documentId = existing?.id ?? createHash('sha256').update(relativePath).digest('hex').slice(0, 24);
  const chunks = chunkMarkdown(content);
  database.exec('BEGIN');
  try {
    database.prepare(`
      INSERT INTO knowledge_documents (id, relative_path, title, excerpt, content, bytes, modified_at, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(relative_path) DO UPDATE SET title = excluded.title, excerpt = excluded.excerpt,
        content = excluded.content, bytes = excluded.bytes, modified_at = excluded.modified_at, indexed_at = excluded.indexed_at
    `).run(documentId, relativePath, title, excerpt, content, fileStat.size, fileStat.mtime.toISOString(), indexedAt);
    database.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(documentId);
    const insertChunk = database.prepare(`INSERT INTO knowledge_chunks (id, document_id, position, heading_path, content, vector_json, start_line, end_line, token_count, content_hash, metadata_json, chunking_version, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'markdown-ast-v3', ?)`);
    chunks.forEach((chunk, position) => {
      const chunkId = createHash('sha256').update(`${documentId}:${position}:${chunk.content}`).digest('hex').slice(0, 24);
      insertChunk.run(chunkId, documentId, position, chunk.headingPath, chunk.content, JSON.stringify(vectorize(`${title}\n${chunk.headingPath}\n${chunk.content}`)), chunk.startLine, chunk.endLine, chunk.tokenCount, createHash('sha256').update(chunk.content).digest('hex'), JSON.stringify(chunk.metadata), indexedAt);
    });
    refreshFts(documentId);
    refreshDocumentRelations();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function searchKnowledgeDocuments(query:string,sourcePath?:string|null,limit=4,projectId?:string|null){
  return retrieveKnowledgeLocal({query,sourcePath:projectId?null:sourcePath,limit,projectId}).hits;
}
