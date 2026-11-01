import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { database, databaseDirectory, nowIso } from '../db.js';
import { forgetMemory } from '../domain/memories/memory-ledger.js';
import { moveDocumentWithLinks } from '../domain/documents/document-service.js';
import { reindexKnowledgeDocument, scanKnowledgeBase } from '../vault.js';

function sha256(value: string) { return createHash('sha256').update(value).digest('hex'); }
function normalized(value: string) { return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); }

function vaultTarget(relativePath: string) {
  const setting = database.prepare(`SELECT value FROM app_settings WHERE key = 'vault_path'`).get() as { value: string } | undefined;
  if (!setting?.value.trim()) throw new Error('没有配置 Obsidian Vault。');
  const vault = resolve(setting.value);
  const target = resolve(vault, relativePath);
  const fromVault = relative(vault, target);
  if (!fromVault || fromVault === '..' || fromVault.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromVault)) throw new Error('撤销目标不在当前 Vault 内。');
  return { vault, target, relativePath: normalized(fromVault) };
}

async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }

function undoTasks(ids: string[], proposalId: string) {
  const timestamp = nowIso();
  const changed: string[] = [];
  database.exec('BEGIN');
  try {
    for (const id of ids) {
      const task = database.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      if (!task || ['done', 'cancelled'].includes(String(task.status))) continue;
      database.prepare(`UPDATE tasks SET status = 'cancelled', updated_at = ?, completed_at = NULL WHERE id = ?`).run(timestamp, id);
      database.prepare(`INSERT INTO task_history (id, task_id, project_id, change_type, before_json, after_json, source_type, source_id, created_at) VALUES (?, ?, ?, 'reverted', ?, ?, 'action_undo', ?, ?)`).run(randomUUID(), id, String(task.project_id), JSON.stringify(task), JSON.stringify({ ...task, status: 'cancelled' }), proposalId, timestamp);
      database.prepare(`INSERT INTO events (id, project_id, event_type, object_type, object_id, title, detail, source_type, source_id, created_at) VALUES (?, ?, 'task_reverted', 'task', ?, ?, '由行动撤销，任务保留为已取消', 'action_undo', ?, ?)`).run(randomUUID(), String(task.project_id), id, `撤销任务：${String(task.title)}`, proposalId, timestamp);
      changed.push(id);
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { taskIds: changed };
}

async function undoDocument(proposal: Record<string, unknown>, result: Record<string, unknown>) {
  const writeRequest = database.prepare(`SELECT * FROM obsidian_write_requests WHERE id = ?`).get(String(proposal.id)) as Record<string, unknown> | undefined;
  if (!writeRequest) throw new Error('找不到原文档操作记录。');
  const action = String(writeRequest.action_type);
  const source = vaultTarget(String(writeRequest.target_path));
  const backup = join(databaseDirectory, 'obsidian-backups', `${String(proposal.id)}.md`);
  if (action === 'create') {
    if (!await exists(source.target)) throw new Error('新建的文档已经不存在，不能重复撤销。');
    const current = await readFile(source.target, 'utf8');
    if (sha256(current) !== sha256(String(writeRequest.proposed_content))) throw new Error('文档创建后又被修改，已阻止撤销以免丢失新内容。');
    const trash = join(source.vault, '.trash', 'AI秘书', `undo-${Date.now()}-${source.relativePath.split('/').at(-1)}`);
    await mkdir(dirname(trash), { recursive: true });
    await rename(source.target, trash);
    await scanKnowledgeBase();
    return { restored: false, trashPath: normalized(relative(source.vault, trash)) };
  }
  if (action === 'modify') {
    if (!await exists(source.target) || !await exists(backup)) throw new Error('当前文档或修改前备份不存在。');
    const current = await readFile(source.target, 'utf8');
    if (sha256(current) !== sha256(String(writeRequest.proposed_content))) throw new Error('文档修改后又发生变化，已阻止撤销。');
    const temporary = `${source.target}.${String(proposal.id)}.undo.tmp`;
    await copyFile(backup, temporary);
    await rename(temporary, source.target);
    await reindexKnowledgeDocument(source.relativePath);
    return { restored: true, relativePath: source.relativePath };
  }
  if (action === 'delete') {
    const trashPath = String(result.trashRelativePath ?? '');
    const trash = vaultTarget(trashPath);
    if (await exists(source.target)) throw new Error('原路径已经存在文件，不能覆盖恢复。');
    if (!await exists(trash.target)) throw new Error('回收站中的原文档不存在。');
    await mkdir(dirname(source.target), { recursive: true });
    await rename(trash.target, source.target);
    await reindexKnowledgeDocument(source.relativePath);
    return { restored: true, relativePath: source.relativePath };
  }
  if (action === 'move') {
    const destinationPath = String(result.movedRelativePath ?? '');
    const destination = vaultTarget(destinationPath);
    if (!await exists(destination.target)) throw new Error('移动后的文档不存在。');
    if (await exists(source.target)) throw new Error('原路径已经有文件，不能覆盖撤销。');
    const current = await readFile(destination.target, 'utf8');
    const moved = await moveDocumentWithLinks({ vaultPath: source.vault, sourceRelativePath: destination.relativePath, destinationRelativePath: source.relativePath, expectedHash: sha256(current), backupDirectory: join(databaseDirectory, 'obsidian-backups') });
    await scanKnowledgeBase();
    return { restored: true, relativePath: moved.destinationRelativePath, affectedLinks: moved.affectedLinks };
  }
  throw new Error('这类文档操作暂不支持撤销。');
}

export async function undoActionProposal(id: string) {
  const proposal = database.prepare(`SELECT * FROM action_proposals WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!proposal) throw new Error('行动提案不存在。');
  if (proposal.status === 'reverted') return proposal.revert_result_json ? JSON.parse(String(proposal.revert_result_json)) : { ok: true };
  if (proposal.status !== 'succeeded') throw new Error('只有已经成功执行的行动可以撤销。');
  const result = proposal.result_json ? JSON.parse(String(proposal.result_json)) as Record<string, unknown> : {};
  let undoResult: Record<string, unknown>;
  if (proposal.action_type === 'task_batch_create') undoResult = undoTasks(Array.isArray(result.created) ? (result.created as Array<{ id: string }>).map((item) => item.id) : [], id);
  else if (proposal.action_type === 'task_create') undoResult = undoTasks(typeof result.taskId === 'string' ? [result.taskId] : [], id);
  else if (proposal.action_type === 'memory_create') {
    const memoryId = String(result.memoryId ?? '');
    forgetMemory(memoryId);
    undoResult = { memoryId, status: 'invalidated' };
  } else if (String(proposal.action_type).startsWith('document_')) undoResult = await undoDocument(proposal, result);
  else throw new Error('这类行动目前不支持自动撤销。');
  const timestamp = nowIso();
  database.prepare(`UPDATE action_proposals SET status = 'reverted', reverted_at = ?, revert_result_json = ?, updated_at = ? WHERE id = ? AND status = 'succeeded'`).run(timestamp, JSON.stringify(undoResult), timestamp, id);
  return undoResult;
}
