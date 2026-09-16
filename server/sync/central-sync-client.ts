import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { hostname, platform } from 'node:os';
import { database, nowIso } from '../db.js';

type LocalFile = { path: string; absolute: string; hash: string; baseHash: string | null; bytes: number; modifiedAt: string };

function setting(key: string, fallback = '') {
  return (database.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined)?.value ?? fallback;
}

const excludedDirectories = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
const excludedSuffixes = ['.tmp', '.part', '.crdownload'];

export class CentralSyncClient {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<ReturnType<CentralSyncClient['status']>> | null = null;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private lastSummary = { scanned: 0, uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, remotePending: 0 };

  private get remoteUrl() { return String(process.env.AI_SECRETARY_REMOTE_URL ?? '').trim().replace(/\/+$/, ''); }
  private get remoteToken() { return String(process.env.AI_SECRETARY_REMOTE_TOKEN ?? '').trim(); }
  private get vaultPath() { return resolve(setting('vault_path')); }
  private get vaultName() { return String(process.env.AI_SECRETARY_VAULT_NAME ?? basename(this.vaultPath)).trim() || 'Obsidian Vault'; }
  private get deviceId() { return String(process.env.AI_SECRETARY_DEVICE_ID ?? setting('sync_device_id')).trim(); }
  private get deviceName() { return String(process.env.AI_SECRETARY_DEVICE_NAME ?? setting('sync_device_name', hostname())).trim(); }
  private get vaultId() { return String(process.env.AI_SECRETARY_LIBRARY_ID ?? process.env.AI_SECRETARY_VAULT_ID ?? setting('central_library_id', 'personal-main')).trim(); }
  private get knowledgePrefix() { return String(process.env.AI_SECRETARY_KNOWLEDGE_PREFIX ?? '').trim(); }
  private get enabled() { return Boolean(this.remoteUrl && setting('sync_enabled', '0') === '1' && setting('vault_path')); }

  status() {
    return {
      enabled: this.enabled, deviceId: this.deviceId, deviceName: this.deviceName, folderPath: this.vaultPath,
      lastRunAt: this.lastRunAt, lastError: this.lastError, pendingOperations: this.lastSummary.remotePending,
      conflictCount: this.lastSummary.conflicts, mode: 'central-server', serverUrl: this.remoteUrl, ...this.lastSummary
    };
  }

  restart() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.enabled) return;
    void this.run().catch(() => undefined);
    this.timer = setInterval(() => { void this.run().catch(() => undefined); }, 20_000);
    this.timer.unref?.();
  }

  run() {
    if (!this.running) this.running = this.runInternal().finally(() => { this.running = null; });
    return this.running;
  }

  private registration() {
    return { deviceId: this.deviceId, deviceName: this.deviceName, platform: platform(), vaultId: this.vaultId, vaultName: this.vaultName, knowledgePrefix: this.knowledgePrefix };
  }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.remoteUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(this.remoteToken ? { Authorization: `Bearer ${this.remoteToken}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000)
    });
    const data = await response.json().catch(() => ({})) as { message?: string } & T;
    if (!response.ok) throw new Error(data.message || `中央服务器返回 ${response.status}`);
    return data;
  }

  private stateRows() {
    return database.prepare('SELECT relative_path,last_hash,modified_at FROM central_local_sync_state WHERE vault_id=?').all(this.vaultId) as Array<{ relative_path: string; last_hash: string; modified_at: string | null }>;
  }

  private saveState(path: string, hash: string, modifiedAt: string | null) {
    database.prepare(`INSERT INTO central_local_sync_state(vault_id,relative_path,last_hash,modified_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(vault_id,relative_path) DO UPDATE SET last_hash=excluded.last_hash,modified_at=excluded.modified_at,updated_at=excluded.updated_at`).run(this.vaultId, path, hash, modifiedAt, nowIso());
  }

  private removeState(path: string) {
    database.prepare('DELETE FROM central_local_sync_state WHERE vault_id=? AND relative_path=?').run(this.vaultId, path);
  }

  private async collect() {
    const maximumBytes = Number(process.env.AI_SECRETARY_MAX_DOCUMENT_BYTES ?? 15 * 1024 * 1024);
    const states = new Map(this.stateRows().map((row) => [row.relative_path, row]));
    const files: LocalFile[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) { await walk(absolute); continue; }
        if (!entry.isFile() || excludedSuffixes.some((suffix) => entry.name.toLowerCase().endsWith(suffix))) continue;
        const info = await stat(absolute);
        if (!info.size || info.size > maximumBytes) continue;
        const path = relative(this.vaultPath, absolute).replaceAll('\\', '/');
        if (path.startsWith('AI秘书/设备同步/')) continue;
        const content = await readFile(absolute);
        files.push({ path, absolute, hash: createHash('sha256').update(content).digest('hex'), baseHash: states.get(path)?.last_hash ?? null, bytes: content.length, modifiedAt: info.mtime.toISOString() });
      }
    };
    await walk(this.vaultPath);
    return { files, states };
  }

  private async upload(file: LocalFile) {
    const content = await readFile(file.absolute);
    return this.request<{ accepted: boolean; contentHash: string; conflict: unknown | null }>('/api/device-sync/documents', { ...this.registration(), path: file.path, contentBase64: content.toString('base64'), contentHash: file.hash, baseHash: file.baseHash, modifiedAt: file.modifiedAt });
  }

  private async runInternal() {
    if (!this.enabled) throw new Error('中央服务器同步尚未配置或未开启。');
    if (!existsSync(join(this.vaultPath, '.obsidian'))) throw new Error('本机 Obsidian Vault 无效。');
    try {
      const { files, states } = await this.collect();
      let uploaded = 0, removed = 0, conflicts = 0;
      const currentPaths = new Set(files.map((file) => file.path));
      for (const [path, state] of states) {
        if (currentPaths.has(path)) continue;
        const result = await this.request<{ deleted: boolean; conflict?: unknown }>('/api/device-sync/delete', { ...this.registration(), path, baseHash: state.last_hash, modifiedAt: state.modified_at });
        if (result.deleted) { this.removeState(path); removed += 1; } else if (result.conflict) conflicts += 1;
      }
      const manifest = await this.request<{ upload: string[] }>('/api/device-sync/manifest', { ...this.registration(), files: files.map(({ absolute: _absolute, ...file }) => file) });
      const byPath = new Map(files.map((file) => [file.path, file]));
      for (const path of manifest.upload) {
        const file = byPath.get(path);
        if (!file) continue;
        const result = await this.upload(file);
        if (result.accepted) { this.saveState(file.path, result.contentHash, file.modifiedAt); uploaded += 1; } else if (result.conflict) conflicts += 1;
      }
      for (const file of files) if (!manifest.upload.includes(file.path) && !states.has(file.path)) this.saveState(file.path, file.hash, file.modifiedAt);
      this.lastRunAt = nowIso();
      this.lastError = null;
      this.lastSummary = { scanned: files.length, uploaded, downloaded: 0, deleted: removed, conflicts, remotePending: 0 };
      return this.status();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : '中央同步失败。';
      throw error;
    }
  }
}
