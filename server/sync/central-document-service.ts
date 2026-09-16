import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { extname, join, posix, resolve } from 'node:path';
import { database, databaseDirectory, nowIso } from '../db.js';
import { indexKnowledgeContent, removeKnowledgeContent } from '../vault.js';

type ManifestFile = { path: string; hash: string; baseHash?: string | null; bytes: number; modifiedAt: string };
type RegisterInput = { deviceId: string; deviceName: string; platform?: string; vaultId: string; vaultName: string; knowledgePrefix?: string };
type UploadInput = RegisterInput & { path: string; contentBase64: string; contentHash?: string; baseHash?: string | null; modifiedAt: string; mimeType?: string };

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const documentRoot = resolve(process.env.AI_SECRETARY_DOCUMENT_ROOT?.trim() || join(databaseDirectory, '..', 'raw-documents'));
const processedRoot = resolve(process.env.AI_SECRETARY_PROCESSED_ROOT?.trim() || join(databaseDirectory, '..', 'processed-documents'));
const maximumDocumentBytes = Number(process.env.AI_SECRETARY_MAX_DOCUMENT_BYTES ?? 15 * 1024 * 1024);

function identifier(value: unknown, label: string) {
  const normalized = String(value ?? '').trim();
  if (!identifierPattern.test(normalized)) throw Object.assign(new Error(`${label}格式不正确。`), { statusCode: 400 });
  return normalized;
}

function relativeDocumentPath(value: unknown) {
  const raw = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const normalized = posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('\0') || normalized.startsWith('/')) {
    throw Object.assign(new Error('文档路径必须是 Vault 内的安全相对路径。'), { statusCode: 400 });
  }
  return normalized;
}

function knowledgePrefix(value: unknown) {
  const raw = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!raw) return '';
  const normalized = relativeDocumentPath(raw);
  return normalized === '.' ? '' : normalized;
}

function hash(value: unknown, label = '内容哈希') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!hashPattern.test(normalized)) throw Object.assign(new Error(`${label}格式不正确。`), { statusCode: 400 });
  return normalized;
}

function isoDate(value: unknown) {
  const parsed = new Date(String(value ?? ''));
  if (!Number.isFinite(parsed.valueOf())) throw Object.assign(new Error('文档修改时间格式不正确。'), { statusCode: 400 });
  return parsed.toISOString();
}

function sourceDocumentId(vaultId: string, path: string) {
  return createHash('sha256').update(`${vaultId}\0${path}`).digest('hex').slice(0, 24);
}

function mimeTypeFor(path: string, provided?: string) {
  if (provided?.trim()) return provided.trim().slice(0, 200);
  const extension = extname(path).toLowerCase();
  if (extension === '.md') return 'text/markdown';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function extensionFor(path: string) {
  const extension = extname(path).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.bin';
}

function register(input: RegisterInput) {
  const deviceId = identifier(input.deviceId, '设备 ID');
  const requestedVaultId = identifier(input.vaultId, 'Vault ID');
  const vaultId = requestedVaultId;
  const deviceName = String(input.deviceName ?? '').trim().slice(0, 120) || deviceId;
  const vaultName = String(input.vaultName ?? '').trim().slice(0, 120) || requestedVaultId;
  const prefix = knowledgePrefix(input.knowledgePrefix);
  const timestamp = nowIso();
  database.prepare(`INSERT INTO central_devices(id,name,platform,created_at,updated_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,platform=excluded.platform,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`).run(deviceId, deviceName, String(input.platform ?? '').slice(0, 80), timestamp, timestamp, timestamp);
  database.prepare(`INSERT INTO central_vaults(id,name,knowledge_prefix,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,knowledge_prefix=excluded.knowledge_prefix,updated_at=excluded.updated_at`).run(vaultId, vaultName, prefix, timestamp, timestamp);
  database.prepare(`INSERT INTO central_vault_members(vault_id,device_id,created_at,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(vault_id,device_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(vaultId, deviceId, timestamp, timestamp);
  const vault = database.prepare('SELECT knowledge_prefix FROM central_vaults WHERE id = ?').get(vaultId) as { knowledge_prefix: string };
  return { deviceId, deviceName, vaultId, knowledgePrefix: vault.knowledge_prefix };
}

async function ensureBlob(contentHash: string, path: string, content: Buffer, mimeType: string) {
  const existing = database.prepare('SELECT storage_path FROM central_document_blobs WHERE content_hash = ?').get(contentHash) as { storage_path: string } | undefined;
  if (existing && existsSync(join(documentRoot, existing.storage_path))) return { storagePath: existing.storage_path, deduplicated: true };
  const storagePath = posix.join('blobs', contentHash.slice(0, 2), `${contentHash}${extensionFor(path)}`);
  const target = join(documentRoot, storagePath);
  await mkdir(resolve(target, '..'), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx' });
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!existsSync(target)) throw error;
  }
  database.prepare(`INSERT INTO central_document_blobs(content_hash,storage_path,bytes,mime_type,created_at) VALUES(?,?,?,?,?) ON CONFLICT(content_hash) DO UPDATE SET storage_path=excluded.storage_path,bytes=excluded.bytes,mime_type=excluded.mime_type`).run(contentHash, storagePath, content.length, mimeType, nowIso());
  return { storagePath, deduplicated: false };
}

function extractTags(path: string, content: string) {
  const tags = new Set(path.split('/').slice(0, -1).map((part) => part.trim()).filter(Boolean));
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? '';
  const inlineTags = frontmatter.match(/^tags?\s*:\s*(.+)$/im)?.[1] ?? '';
  inlineTags.replace(/^\[|\]$/g, '').split(/[,，]/).map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).forEach((item) => tags.add(item));
  const multilineTags = frontmatter.match(/^tags?\s*:\s*\r?\n((?:\s*-\s*.+\r?\n?)+)/im)?.[1] ?? '';
  for (const match of multilineTags.matchAll(/^\s*-\s*(.+)$/gm)) tags.add(match[1].trim().replace(/^['"]|['"]$/g, ''));
  for (const match of content.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]{2,50})/gu)) tags.add(match[1]);
  return [...tags].filter(Boolean).slice(0, 50);
}

function canonicalKnowledgeDocument(contentHash: string, excludeSourceId = '') {
  return database.prepare(`
    SELECT d.id AS documentId,d.relative_path AS relativePath,d.title,
      (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.document_id=d.id) AS chunks,d.indexed_at AS indexedAt
    FROM central_source_documents s
    JOIN knowledge_documents d ON d.relative_path=s.knowledge_path
    WHERE s.current_hash=? AND s.id<>?
    ORDER BY CASE WHEN s.deleted_at IS NULL THEN 0 ELSE 1 END,s.created_at
    LIMIT 1
  `).get(contentHash, excludeSourceId) as { documentId: string; relativePath: string; title: string; chunks: number; indexedAt: string } | undefined;
}

function liveSourceCount(contentHash: string) {
  return Number((database.prepare('SELECT COUNT(*) AS count FROM central_source_documents WHERE current_hash=? AND deleted_at IS NULL').get(contentHash) as { count: number }).count);
}

async function preserveKnowledgeForAnotherSource(contentHash: string, changingSourceId: string, overwrittenKnowledgePath: string) {
  const remaining = database.prepare(`SELECT s.knowledge_path,s.current_modified_at,b.storage_path,b.bytes FROM central_source_documents s JOIN central_document_blobs b ON b.content_hash=s.current_hash WHERE s.current_hash=? AND s.id<>? AND s.deleted_at IS NULL ORDER BY s.updated_at DESC LIMIT 1`).get(contentHash, changingSourceId) as { knowledge_path: string; current_modified_at: string | null; storage_path: string; bytes: number } | undefined;
  if (!remaining || remaining.knowledge_path === overwrittenKnowledgePath) return;
  const content = await readFile(join(documentRoot, remaining.storage_path), 'utf8');
  indexKnowledgeContent({ relativePath: remaining.knowledge_path, content, modifiedAt: remaining.current_modified_at ?? nowIso(), bytes: remaining.bytes });
}

export async function acceptCentralDocument(input: UploadInput) {
  const registration = register(input);
  const path = relativeDocumentPath(input.path);
  const modifiedAt = isoDate(input.modifiedAt);
  const content = Buffer.from(String(input.contentBase64 ?? ''), 'base64');
  if (!content.length) throw Object.assign(new Error('原始文档内容为空。'), { statusCode: 400 });
  if (content.length > maximumDocumentBytes) throw Object.assign(new Error(`单个文件不能超过 ${Math.floor(maximumDocumentBytes / 1024 / 1024)}MB。`), { statusCode: 413 });
  const contentHash = createHash('sha256').update(content).digest('hex');
  if (input.contentHash && hash(input.contentHash) !== contentHash) throw Object.assign(new Error('上传内容与声明的哈希不一致。'), { statusCode: 409 });
  const baseHash = input.baseHash ? hash(input.baseHash, '基础版本哈希') : null;
  const mimeType = mimeTypeFor(path, input.mimeType);
  const blob = await ensureBlob(contentHash, path, content, mimeType);
  const sourceId = sourceDocumentId(registration.vaultId, path);
  const libraryPath = posix.join('设备资料', registration.vaultId, path);
  const knowledgePath = registration.knowledgePrefix ? posix.join(registration.knowledgePrefix, libraryPath) : libraryPath;
  const timestamp = nowIso();
  const existing = database.prepare('SELECT current_hash,current_modified_at,knowledge_path FROM central_source_documents WHERE id = ?').get(sourceId) as { current_hash: string | null; current_modified_at: string | null; knowledge_path: string } | undefined;
  database.prepare(`INSERT INTO central_source_documents(id,vault_id,relative_path,knowledge_path,current_hash,current_modified_at,created_at,updated_at,deleted_at) VALUES(?,?,?,?,NULL,NULL,?,?,NULL) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,deleted_at=NULL`).run(sourceId, registration.vaultId, path, knowledgePath, timestamp, timestamp);
  database.prepare(`INSERT OR IGNORE INTO central_document_versions(id,source_document_id,device_id,content_hash,base_hash,modified_at,created_at) VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), sourceId, registration.deviceId, contentHash, baseHash, modifiedAt, timestamp);
  database.prepare(`INSERT INTO central_document_replicas(source_document_id,device_id,present,content_hash,modified_at,updated_at) VALUES(?,?,1,?,?,?) ON CONFLICT(source_document_id,device_id) DO UPDATE SET present=1,content_hash=excluded.content_hash,modified_at=excluded.modified_at,updated_at=excluded.updated_at`).run(sourceId, registration.deviceId, contentHash, modifiedAt, timestamp);

  let accepted = !existing?.current_hash || existing.current_hash === contentHash;
  let conflict: { id: string; resolution: string } | null = null;
  if (existing?.current_hash && existing.current_hash !== contentHash) {
    const staleBase = Boolean(baseHash && baseHash !== existing.current_hash);
    const olderThanServer = Boolean(!baseHash && existing.current_modified_at && modifiedAt < existing.current_modified_at);
    if (staleBase || olderThanServer) {
      const resolution = olderThanServer ? 'kept_newer_server' : 'pending';
      const conflictId = randomUUID();
      database.prepare(`INSERT INTO central_document_conflicts(id,source_document_id,device_id,server_hash,incoming_hash,base_hash,resolution,created_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(conflictId, sourceId, registration.deviceId, existing.current_hash, contentHash, baseHash, resolution, timestamp, resolution === 'pending' ? null : timestamp);
      conflict = { id: conflictId, resolution };
      accepted = false;
    } else accepted = true;
  }

  let indexed: ReturnType<typeof indexKnowledgeContent> | null = null;
  let canonicalKnowledgePath: string | null = null;
  if (accepted) {
    const oldHash = existing?.current_hash ?? null;
    const oldCanonicalPath = oldHash ? canonicalKnowledgeDocument(oldHash)?.relativePath ?? null : null;
    database.prepare('UPDATE central_source_documents SET current_hash=?,current_modified_at=?,updated_at=?,deleted_at=NULL WHERE id=?').run(contentHash, modifiedAt, timestamp, sourceId);
    if (oldHash && oldHash !== contentHash && oldCanonicalPath === existing?.knowledge_path && liveSourceCount(oldHash) > 0) {
      await preserveKnowledgeForAnotherSource(oldHash, sourceId, existing.knowledge_path);
    }
    if (path.toLowerCase().endsWith('.md')) {
      const canonical = canonicalKnowledgeDocument(contentHash, sourceId);
      if (canonical) {
        canonicalKnowledgePath = canonical.relativePath;
        indexed = { ...canonical, reused: true };
      } else {
        indexed = indexKnowledgeContent({ relativePath: knowledgePath, content: content.toString('utf8'), modifiedAt, bytes: content.length });
        canonicalKnowledgePath = indexed.relativePath;
      }
    }
    if (oldHash && oldHash !== contentHash && liveSourceCount(oldHash) === 0 && oldCanonicalPath && oldCanonicalPath !== knowledgePath) removeKnowledgeContent(oldCanonicalPath);
    await mkdir(join(processedRoot, registration.vaultId), { recursive: true });
    await writeFile(join(processedRoot, registration.vaultId, `${sourceId}-${contentHash}.json`), JSON.stringify({ sourceDocumentId: sourceId, deviceId: registration.deviceId, deviceName: registration.deviceName, vaultId: registration.vaultId, relativePath: path, knowledgePath, canonicalKnowledgePath, contentHash, modifiedAt, mimeType, tags: path.toLowerCase().endsWith('.md') ? extractTags(path, content.toString('utf8')) : [], indexed, processing: { deduplicated: blob.deduplicated, parsed: Boolean(indexed), chunked: Boolean(indexed), vectorized: Boolean(indexed) } }, null, 2), 'utf8');
  }
  return { sourceDocumentId: sourceId, contentHash, accepted, deduplicated: blob.deduplicated, indexed, canonicalKnowledgePath, conflict };
}

export function compareCentralManifest(input: RegisterInput & { files: ManifestFile[] }) {
  const registration = register(input);
  const files = Array.isArray(input.files) ? input.files.slice(0, 100_000) : [];
  const upload: string[] = [];
  for (const file of files) {
    const path = relativeDocumentPath(file.path);
    const contentHash = hash(file.hash);
    const sourceId = sourceDocumentId(registration.vaultId, path);
    const current = database.prepare('SELECT current_hash,deleted_at FROM central_source_documents WHERE id = ?').get(sourceId) as { current_hash: string | null; deleted_at: string | null } | undefined;
    const replica = database.prepare('SELECT content_hash,present FROM central_document_replicas WHERE source_document_id=? AND device_id=?').get(sourceId, registration.deviceId) as { content_hash: string | null; present: number } | undefined;
    const baseHash = file.baseHash ? hash(file.baseHash, '基础版本哈希') : null;
    if (!current) upload.push(path);
    else if (current.deleted_at) {
      if (!baseHash || contentHash !== baseHash) upload.push(path);
    } else if (current.current_hash === contentHash) {
      if (!replica?.present || replica.content_hash !== contentHash) upload.push(path);
    } else if (!baseHash || contentHash !== baseHash || current.current_hash === baseHash) upload.push(path);
  }
  // Kept as empty arrays for older clients. The central server never writes into a device Vault.
  return { upload, remote: [], deleted: [], missing: 0, total: files.length };
}

export function deleteCentralDocument(input: RegisterInput & { path: string; baseHash: string; modifiedAt?: string }) {
  const registration = register(input);
  const path = relativeDocumentPath(input.path);
  const baseHash = hash(input.baseHash, '基础版本哈希');
  const sourceId = sourceDocumentId(registration.vaultId, path);
  const source = database.prepare('SELECT current_hash,knowledge_path,deleted_at FROM central_source_documents WHERE id=?').get(sourceId) as { current_hash: string | null; knowledge_path: string; deleted_at: string | null } | undefined;
  if (!source) return { deleted: false, reason: 'not_found' };
  if (source.deleted_at) return { deleted: true, alreadyDeleted: true };
  if (source.current_hash !== baseHash) {
    const conflictId = randomUUID();
    const timestamp = nowIso();
    database.prepare(`INSERT INTO central_document_conflicts(id,source_document_id,device_id,server_hash,incoming_hash,base_hash,resolution,created_at) VALUES(?,?,?,?,?,?, 'pending',?)`).run(conflictId, sourceId, registration.deviceId, source.current_hash ?? '', baseHash, baseHash, timestamp);
    return { deleted: false, conflict: { id: conflictId, resolution: 'pending' } };
  }
  const timestamp = nowIso();
  database.prepare(`INSERT INTO central_document_replicas(source_document_id,device_id,present,content_hash,modified_at,updated_at) VALUES(?,?,0,?,?,?) ON CONFLICT(source_document_id,device_id) DO UPDATE SET present=0,updated_at=excluded.updated_at`).run(sourceId, registration.deviceId, source.current_hash, input.modifiedAt ? isoDate(input.modifiedAt) : timestamp, timestamp);
  const remainingReplicas = Number((database.prepare('SELECT COUNT(*) AS count FROM central_document_replicas WHERE source_document_id=? AND present=1').get(sourceId) as { count: number }).count);
  if (remainingReplicas > 0) {
    database.prepare('UPDATE central_source_documents SET updated_at=? WHERE id=?').run(timestamp, sourceId);
    return { deleted: true, sourceDocumentId: sourceId, retainedOnServer: true, deletedAt: timestamp };
  }
  const canonicalPath = source.current_hash ? canonicalKnowledgeDocument(source.current_hash)?.relativePath ?? null : null;
  database.prepare('UPDATE central_source_documents SET deleted_at=?,updated_at=? WHERE id=?').run(timestamp, timestamp, sourceId);
  if (source.current_hash && liveSourceCount(source.current_hash) === 0 && canonicalPath) removeKnowledgeContent(canonicalPath);
  return { deleted: true, sourceDocumentId: sourceId, retainedOnServer: false, deletedAt: timestamp };
}

export function centralSyncStatus() {
  const count = (table: string, where = '') => Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as { count: number }).count);
  return {
    devices: count('central_devices'), vaults: count('central_vaults'), sourceDocuments: count('central_source_documents', 'WHERE deleted_at IS NULL'),
    rawBlobs: count('central_document_blobs'), versions: count('central_document_versions'), conflicts: count('central_document_conflicts', "WHERE resolution='pending'"),
    pendingCommands: count('central_device_commands', "WHERE status='pending'")
  };
}

export async function centralBlob(contentHash: string) {
  const normalized = hash(contentHash);
  const row = database.prepare('SELECT storage_path,mime_type,bytes FROM central_document_blobs WHERE content_hash=?').get(normalized) as { storage_path: string; mime_type: string; bytes: number } | undefined;
  if (!row) throw Object.assign(new Error('原始文件不存在。'), { statusCode: 404 });
  return { ...row, content: await readFile(join(documentRoot, row.storage_path)) };
}
