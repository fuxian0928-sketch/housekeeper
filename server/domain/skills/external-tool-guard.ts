import { createHash, randomUUID } from 'node:crypto';
import { database, nowIso } from '../../db.js';
import { isUnknownToolOutcome, unknownToolOutcome } from './tool-outcome.js';

const activeAttempts=new Set<string>();

function canonical(value: unknown): unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical((value as Record<string,unknown>)[key])]));
  return value;
}
function ensureStore(){
  database.exec(`CREATE TABLE IF NOT EXISTS external_tool_dispatches (
    fingerprint TEXT PRIMARY KEY, tool_name TEXT NOT NULL, attempt_id TEXT NOT NULL,
    status TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS external_tool_resolutions (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, attempt_id TEXT NOT NULL,
    outcome TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL)`);
}
function toolFingerprint(name:string,args:unknown){return createHash('sha256').update(JSON.stringify([name,canonical(args)])).digest('hex');}
export function uncertainToolCall(name:string,args:unknown){
  ensureStore();
  const row=database.prepare("SELECT fingerprint,attempt_id AS attemptId FROM external_tool_dispatches WHERE fingerprint=? AND status IN ('running','unknown')").get(toolFingerprint(name,args));
  return row?{fingerprint:String(row.fingerprint),attemptId:String(row.attemptId),canResolve:!activeAttempts.has(String(row.attemptId))}:null;
}
export function listUncertainToolCalls(){
  ensureStore();
  const rows=database.prepare("SELECT fingerprint,tool_name AS toolName,attempt_id AS attemptId,status,updated_at AS updatedAt FROM external_tool_dispatches WHERE status IN ('running','unknown') ORDER BY updated_at DESC LIMIT 100").all() as Array<{fingerprint:string;toolName:string;attemptId:string;status:string;updatedAt:string}>;
  return rows.map(row=>({...row,canResolve:!activeAttempts.has(String(row.attemptId))}));
}
export function reconcileToolCall(input:Record<string,unknown>){
  ensureStore();
  const {fingerprint,attemptId,outcome,note,confirmed}=input;
  const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
  if(confirmed!==true||typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint)||typeof attemptId!=='string'||attemptId.length>100
    ||!['executed','not_executed'].includes(String(outcome))||typeof note!=='string'||note.trim().length<3||note.length>1000)throw fail('请明确核对结果，并填写核对依据（3–1000字）。');
  if(activeAttempts.has(attemptId))throw fail('原操作仍在执行，请等待结果。',409);
  database.exec('SAVEPOINT reconcile_external_tool');
  try{
    const claimed=database.prepare("UPDATE external_tool_dispatches SET status='reconciled',updated_at=? WHERE fingerprint=? AND attempt_id=? AND status IN ('unknown','running')").run(nowIso(),fingerprint,attemptId);
    if(!claimed.changes)throw fail('操作状态已变化，请刷新后再核对。',409);
    const id=randomUUID(),createdAt=nowIso();
    database.prepare('INSERT INTO external_tool_resolutions VALUES(?,?,?,?,?,?)').run(id,fingerprint,attemptId,String(outcome),note.trim(),createdAt);
    const evidence=JSON.stringify({source:'user_verification',outcome,note:note.trim(),resolutionId:id});
    const records=database.prepare("SELECT id,tool_name,arguments_json,proposal_id FROM skill_tool_executions WHERE status='unknown'").all();
    for(const row of records){
      let args:unknown;try{args=JSON.parse(String(row.arguments_json));}catch{continue;}
      if(toolFingerprint(String(row.tool_name),args)!==fingerprint)continue;
      database.prepare("UPDATE skill_tool_executions SET status='reconciled',result_json=?,updated_at=?,completed_at=? WHERE id=? AND status='unknown'").run(evidence,createdAt,createdAt,String(row.id));
      if(row.proposal_id)database.prepare("UPDATE action_proposals SET status='reconciled',result_json=?,updated_at=? WHERE id=? AND status='unknown'").run(evidence,createdAt,String(row.proposal_id));
    }
    database.exec('RELEASE reconcile_external_tool');return {id,outcome,retried:false};
  }catch(error){database.exec('ROLLBACK TO reconcile_external_tool');database.exec('RELEASE reconcile_external_tool');throw error;}
}

/** Shared dispatch guard. A leftover running row after a crash is never retried automatically. */
export async function guardedExternalTool<T>(name:string,args:Record<string,unknown>,execute:()=>Promise<T>):Promise<T> {
  ensureStore();
  const fingerprint=toolFingerprint(name,args);
  const attempt=randomUUID();
  const claim=database.prepare(`INSERT INTO external_tool_dispatches VALUES(?,?,?,'running',?)
    ON CONFLICT(fingerprint) DO UPDATE SET attempt_id=excluded.attempt_id,status='running',updated_at=excluded.updated_at
    WHERE external_tool_dispatches.status NOT IN ('running','unknown')`).run(fingerprint,name,attempt,nowIso());
  if(!claim.changes){
    const prior=database.prepare('SELECT attempt_id,status FROM external_tool_dispatches WHERE fingerprint=?').get(fingerprint) as {attempt_id:string;status:string}|undefined;
    if(prior?.status==='running'&&activeAttempts.has(prior.attempt_id))throw Object.assign(new Error('相同操作仍在执行，本次未重复发送。请等待原操作结果。'),{code:'TOOL_IN_PROGRESS',statusCode:409});
    throw unknownToolOutcome();
  }
  activeAttempts.add(attempt);
  const finish=(status:string)=>database.prepare('UPDATE external_tool_dispatches SET status=?,updated_at=? WHERE fingerprint=? AND attempt_id=?').run(status,nowIso(),fingerprint,attempt);
  try {
  let result:T;
  try { result=await execute(); }
  catch(error){finish(isUnknownToolOutcome(error)?'unknown':'failed');throw error;}
  // If recording success fails, leave the running claim in place for reconciliation.
  finish('succeeded');return result;
  } finally { activeAttempts.delete(attempt); }
}
