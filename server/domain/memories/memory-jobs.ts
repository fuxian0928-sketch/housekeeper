import { randomUUID } from 'node:crypto';
import { database, nowIso } from '../../db.js';

const leaseMs = 120_000;
export const memoryJobMaxAttempts = 5;
export function recoverExpiredMemoryJobs(at = nowIso()) {
  return Number(database.prepare(`UPDATE memory_observations SET status=CASE WHEN attempt_count>=? THEN 'failed' ELSE 'pending' END,lease_token=NULL,lease_expires_at=NULL WHERE status='processing' AND (lease_expires_at IS NULL OR lease_expires_at<=?)`).run(memoryJobMaxAttempts,at).changes);
}
export function claimMemoryJob(id: string) {
  const token = randomUUID();
  const result = database.prepare(`UPDATE memory_observations SET status='processing',lease_token=?,lease_expires_at=?,attempt_count=attempt_count+1,error_message=NULL WHERE id=? AND status='pending' AND attempt_count<?`).run(token,new Date(Date.now()+leaseMs).toISOString(),id,memoryJobMaxAttempts);
  return result.changes ? token : null;
}
export function assertMemoryJobOwner(id: string, token: string) {
  if (!database.prepare(`SELECT id FROM memory_observations WHERE id=? AND status='processing' AND lease_token=? AND lease_expires_at>?`).get(id,token,nowIso())) throw new Error('记忆提取已被取消或接管，旧结果未继续写入。');
  if (database.prepare("SELECT value FROM app_settings WHERE key='memory_auto_capture'").get()?.value === '0') throw new Error('自动记忆已关闭，本次提取不再写入。');
}
export function keepMemoryJobAlive(id: string, token: string) {
  const timer = setInterval(() => {
    database.prepare(`UPDATE memory_observations SET lease_expires_at=? WHERE id=? AND status='processing' AND lease_token=? AND lease_expires_at>?`).run(new Date(Date.now()+leaseMs).toISOString(),id,token,nowIso());
  },30_000);
  timer.unref();
  return () => clearInterval(timer);
}
export function failMemoryJob(id: string, token: string, error: unknown) {
  const row = database.prepare('SELECT attempt_count FROM memory_observations WHERE id=? AND lease_token=?').get(id,token) as {attempt_count:number} | undefined;
  if (!row) return;
  const backoff = Math.min(20*60_000,1000*2**Math.max(0,row.attempt_count-1));
  database.prepare(`UPDATE memory_observations SET status='failed',processed_at=?,error_message=?,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=? WHERE id=? AND lease_token=?`).run(nowIso(),error instanceof Error?error.message.slice(0,1000):'未知错误',new Date(Date.now()+backoff).toISOString(),id,token);
}
