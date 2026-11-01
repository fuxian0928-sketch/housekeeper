import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {database,nowIso} from '../../db.js';
import {unknownToolOutcome} from '../skills/tool-outcome.js';
import {agentInvocationActive,appendAgentEvent} from '../agent/run-store.js';
import {computerControlBlocked,handoffComputerControl} from './computer-control-handoff.js';

export const COMPUTER_ACTIONS=['App','Click','Type','Scroll','Move','Shortcut'] as const;
const allowed=new Set<string>(['ControlStatus','Snapshot',...COMPUTER_ACTIONS]);
const fail=(message:string,code=400)=>Object.assign(new Error(message),{statusCode:code});
type CatalogTool={name:string;description?:string;inputSchema:Record<string,unknown>};
type Device={device_id:string;token_hash:string;session_id:string;tools_json:string;last_seen:number;enabled:number};
let stored=false;
function store(){if(stored)return;database.exec(`CREATE TABLE IF NOT EXISTS computer_devices(device_id TEXT PRIMARY KEY,token_hash TEXT NOT NULL,session_id TEXT NOT NULL,tools_json TEXT NOT NULL,last_seen INTEGER NOT NULL,enabled INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS computer_commands(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,tool TEXT NOT NULL,args_json TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,control_lease TEXT);`);
  if(!database.prepare('PRAGMA table_info(computer_commands)').all().some(row=>row.name==='control_lease'))database.exec('ALTER TABLE computer_commands ADD COLUMN control_lease TEXT');stored=true;
}
function digest(value:string){return createHash('sha256').update(value).digest();}
function device(id:string){store();return database.prepare('SELECT * FROM computer_devices WHERE device_id=?').get(id) as Device|undefined;}
function authenticate(id:unknown,token:unknown){if(typeof id!=='string'||typeof token!=='string'||token.length<32||token.length>200)throw fail('电脑连接身份无效。',403);const row=device(id);if(!row||!timingSafeEqual(Buffer.from(row.token_hash,'hex'),digest(token)))throw fail('电脑连接认证失败。',403);return row;}
export function authorizeComputerCaller(input:unknown){if(!input||typeof input!=='object')return null;const value=input as {deviceId?:unknown;token?:unknown};const row=authenticate(value.deviceId,value.token);computerCatalog(row.device_id);return {deviceId:row.device_id,sessionId:row.session_id};}
export function registerComputer(input:{deviceId:unknown;token:unknown;tools:unknown}){
  if(typeof input.deviceId!=='string'||!/^[a-zA-Z0-9_-]{8,160}$/.test(input.deviceId)||typeof input.token!=='string'||!/^[a-f0-9]{64}$/.test(input.token))throw fail('本机连接标识无效。');
  const old=device(input.deviceId);if(old)authenticate(input.deviceId,input.token);
  if(!Array.isArray(input.tools)||input.tools.length>30||JSON.stringify(input.tools).length>80000)throw fail('本机工具目录无效。');
  const tools=(input.tools as CatalogTool[]).filter(tool=>allowed.has(tool.name));
  if(!tools.some(tool=>tool.name==='Snapshot')||tools.some(tool=>tool.inputSchema?.type!=='object')||new Set(tools.map(tool=>tool.name)).size!==tools.length)throw fail('本机工具目录缺少有效的状态读取能力。');
  const sessionId=randomUUID();
  if(old)database.prepare("UPDATE computer_commands SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'unknown' END,error='电脑连接已重新建立；旧操作不会重放',updated_at=? WHERE device_id=? AND status IN ('queued','dispatched')").run(nowIso(),old.device_id);
  database.prepare('INSERT INTO computer_devices VALUES(?,?,?,?,?,1) ON CONFLICT(device_id) DO UPDATE SET session_id=excluded.session_id,tools_json=excluded.tools_json,last_seen=excluded.last_seen,enabled=1').run(input.deviceId,digest(input.token).toString('hex'),sessionId,JSON.stringify(tools),Date.now());
  return {connected:true,sessionId,toolCount:tools.length};
}
export function computerCatalog(deviceId?:string){const row=deviceId?device(deviceId):undefined;if(!row?.enabled||Date.now()-row.last_seen>90000)throw fail('当前电脑尚未连接，请先在希微中连接本机控制。',409);return JSON.parse(row.tools_json) as CatalogTool[];}
export function computerSession(deviceId?:string){computerCatalog(deviceId);return device(deviceId!)!.session_id;}
export function disconnectComputer(deviceId:unknown,token:unknown){const row=authenticate(deviceId,token);database.prepare('UPDATE computer_devices SET enabled=0 WHERE device_id=?').run(row.device_id);database.prepare("UPDATE computer_commands SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'unknown' END,error='用户断开了电脑控制',updated_at=? WHERE device_id=? AND status IN ('queued','dispatched')").run(nowIso(),row.device_id);return {connected:false};}
export function pollComputer(deviceId:unknown,token:unknown){
  const row=authenticate(deviceId,token);if(!row.enabled)throw fail('电脑控制已断开。',409);
  database.prepare('UPDATE computer_devices SET last_seen=? WHERE device_id=?').run(Date.now(),row.device_id);
  const job=database.prepare("SELECT id,tool,args_json,run_id,created_at FROM computer_commands WHERE device_id=? AND session_id=? AND status='queued' ORDER BY rowid LIMIT 1").get(row.device_id,row.session_id);
  if(!job)return {command:null};
  const run=database.prepare('SELECT status,cancel_requested FROM agent_runs WHERE id=?').get(job.run_id);
  const active=database.prepare("SELECT id FROM agent_invocations WHERE run_id=? AND status='dispatching'").all(job.run_id).some(invocation=>agentInvocationActive(String(invocation.id)));
  if(!run||run.cancel_requested||!['running','waiting_approval'].includes(String(run.status))||!active||Date.now()-Date.parse(String(job.created_at))>60000){database.prepare("UPDATE computer_commands SET status='cancelled',error='原事务已停止，未执行电脑操作',updated_at=? WHERE id=?").run(nowIso(),job.id);return {command:null};}
  const claimed=database.prepare("UPDATE computer_commands SET status='dispatched',updated_at=? WHERE id=? AND status='queued'").run(nowIso(),job.id);
  return {command:claimed.changes?{id:job.id,tool:job.tool,arguments:JSON.parse(String(job.args_json)),sessionId:row.session_id}:null};
}
export function receiveComputerReceipt(input:{deviceId:unknown;token:unknown;id:unknown;sessionId:unknown;result?:unknown;error?:unknown;outcomeUnknown?:unknown}){
  const row=authenticate(input.deviceId,input.token);const job=database.prepare('SELECT * FROM computer_commands WHERE id=? AND device_id=? AND session_id=?').get(String(input.id),row.device_id,String(input.sessionId));
  if(!job)throw fail('操作回执无效或已经记录。',409);
  const resultJson=JSON.stringify(input.result??null),error=typeof input.error==='string'?input.error.slice(0,1000):null;
  if(resultJson.length>180000)throw fail('电脑回执过长。');
  // A lost HTTP acknowledgement may resend the same receipt, never the action.
  if(['succeeded','failed','unknown'].includes(String(job.status))&&job.result_json!==null){
    if(job.result_json===resultJson&&job.error===error&&(job.status==='unknown'||(input.outcomeUnknown!==true&&job.status===(error?'failed':'succeeded'))))return {recorded:true,status:String(job.status),duplicate:true};
    throw fail('操作回执已经记录，重复结果不一致。',409);
  }
  if(!['dispatched','unknown'].includes(String(job.status)))throw fail('操作回执无效或已经记录。',409);
  const status=job.status==='unknown'||input.outcomeUnknown===true?'unknown':input.error?'failed':'succeeded';
  database.prepare('UPDATE computer_commands SET status=?,result_json=?,error=?,updated_at=? WHERE id=?').run(status,resultJson,error,nowIso(),job.id);
  return {recorded:true,status};
}
type ComputerRequest={deviceId?:string;runId?:string;sessionId?:string;tool:string;arguments:Record<string,unknown>};
function assertComputerRequest(input:ComputerRequest):asserts input is ComputerRequest&{runId:string;deviceId:string;sessionId:string}{
  if(!input.runId||!input.deviceId)throw fail('电脑操作必须属于本机授权的明确事务。',409);
  if(!input.sessionId||input.sessionId!==computerSession(input.deviceId))throw fail('电脑连接已经变化或缺少本机授权，请重新准备操作。',409);
  const run=database.prepare('SELECT status,cancel_requested FROM agent_runs WHERE id=?').get(input.runId);
  if(!run||run.cancel_requested||!['running','waiting_approval'].includes(String(run.status)))throw fail('这项事务已暂停或取消，没有继续操作电脑。',409);
}
function computerControlLease(runId:string){
  const lease=database.prepare('SELECT lease_token FROM agent_runs WHERE id=?').get(runId)?.lease_token;
  if(typeof lease==='string')return lease;
  const invocation=database.prepare("SELECT id FROM agent_invocations WHERE run_id=? AND status='dispatching' ORDER BY rowid DESC").all(runId).find(row=>agentInvocationActive(String(row.id)));
  return invocation?`approval:${String(invocation.id)}`:`run:${runId}`;
}
export async function requestComputerTool(input:ComputerRequest,signal?:AbortSignal){
  signal?.throwIfAborted();if(!input.runId)throw fail('电脑操作必须属于一项明确事务。',409);
  const tools=computerCatalog(input.deviceId),tool=tools.find(tool=>tool.name===input.tool);if(!tool||!allowed.has(input.tool))throw fail('这项电脑能力未开放。',403);
  if(!input.sessionId||input.sessionId!==computerSession(input.deviceId))throw fail('电脑连接已经变化或缺少本机授权，请重新准备操作。',409);
  const {AjvJsonSchemaValidator}=await import('@modelcontextprotocol/sdk/validation/ajv-provider.js');
  if(!new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(input.arguments).valid)throw fail('电脑操作参数不符合本机工具定义。');
  assertComputerRequest(input);
  if(input.tool!=='ControlStatus'){
    if(!tools.some(tool=>tool.name==='ControlStatus'))throw fail('电脑控制组件需要重新连接，尚未读取控制权状态。',409);
    // A genuine Continue claims a new execution lease. Its send/click can hand
    // off once again, but observations and pending coordinates from the previous
    // lease cannot authorize a new write.
    const prior=database.prepare("SELECT tool,status FROM computer_commands WHERE device_id=? AND session_id=? AND run_id=? AND control_lease=? AND tool!='ControlStatus' ORDER BY rowid DESC LIMIT 1").get(input.deviceId,input.sessionId,input.runId,computerControlLease(input.runId));
    const initial=!prior;
    // Coordinate/element actions must be based on a fresh successful Snapshot.
    // Launch-by-allowlisted-name is independent of old screen coordinates.
    if(COMPUTER_ACTIONS.includes(input.tool as typeof COMPUTER_ACTIONS[number])&&!(initial&&input.tool==='App'&&(input.arguments.mode??'launch')==='launch')&&(!prior||prior.tool!=='Snapshot'||prior.status!=='succeeded'))throw fail('请先用 computer_snapshot 读取当前界面，再根据最新窗口操作；本次没有执行。',409);
    const invocation=database.prepare("SELECT id FROM agent_invocations WHERE run_id=? AND status='dispatching' ORDER BY rowid DESC").all(input.runId).find(row=>agentInvocationActive(String(row.id)));
    const progress=(type:string,label:string)=>appendAgentEvent(input.runId!,type,label,{invocationId:invocation?.id});
    await handoffComputerControl({initial,signal,
      readStatus:()=>sendComputerCommand({...input,tool:'ControlStatus',arguments:{}},signal),
      onWaiting:()=>progress('computer_control_wait','等待键鼠空闲，随后自动开始操作'),
      onReady:()=>progress('computer_control_ready','电脑已交接，继续当前操作'),
    });
  }
  return sendComputerCommand(input,signal);
}
async function sendComputerCommand(input:ComputerRequest,signal?:AbortSignal){
  signal?.throwIfAborted();assertComputerRequest(input);
  const row=device(input.deviceId!)!,id=randomUUID(),at=nowIso();
  database.prepare('INSERT INTO computer_commands(id,device_id,session_id,run_id,tool,args_json,status,created_at,updated_at,control_lease) VALUES(?,?,?,?,?,?,\'queued\',?,?,?)').run(id,row.device_id,row.session_id,input.runId,input.tool,JSON.stringify(input.arguments),at,at,computerControlLease(input.runId));
  const started=Date.now();
  while(Date.now()-started<60000){
    const current=database.prepare('SELECT status,result_json,error FROM computer_commands WHERE id=?').get(id)!;
    if(current.status==='succeeded')return JSON.parse(String(current.result_json));
    if(current.status==='failed'){
      const result=current.result_json?JSON.parse(String(current.result_json)):{};
      if(['USER_CONTROL','TAKEOVER_PENDING','CONTROL_UNAVAILABLE','CONTROL_PREEMPTED'].includes(result.controlCode))throw computerControlBlocked(result.controlCode);
      throw fail(String(current.error??'本机操作未完成。'),422);
    }
    if(current.status==='unknown')throw unknownToolOutcome();
    if(current.status==='cancelled')throw fail('电脑操作在发送前已取消。',409);
    const run=database.prepare('SELECT status,cancel_requested FROM agent_runs WHERE id=?').get(input.runId);
    if(signal?.aborted||!run||run.cancel_requested||!['running','waiting_approval'].includes(String(run.status)))break;
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  const rowAfter=database.prepare('SELECT status,result_json FROM computer_commands WHERE id=?').get(id);
  if(rowAfter?.status==='succeeded')return JSON.parse(String(rowAfter.result_json));
  if(rowAfter?.status==='queued'){database.prepare("UPDATE computer_commands SET status='cancelled',updated_at=? WHERE id=? AND status='queued'").run(nowIso(),id);throw fail('电脑未接收操作，本次没有执行。',409);}
  database.prepare("UPDATE computer_commands SET status='unknown',updated_at=? WHERE id=? AND status='dispatched'").run(nowIso(),id);throw unknownToolOutcome();
}
