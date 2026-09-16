import { randomUUID } from 'node:crypto';
import { database, nowIso } from '../../db.js';

function ensureStore() {
  database.exec(`CREATE TABLE IF NOT EXISTS capability_tool_runs (id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, status TEXT NOT NULL, elapsed_ms INTEGER NOT NULL, error TEXT, created_at TEXT NOT NULL)`);
}
export function toolEnabled(name: string) {
  return (database.prepare('SELECT value FROM app_settings WHERE key=?').get(`tool_enabled:${name}`) as {value:string}|undefined)?.value !== '0';
}
export function saveToolEnabled(name: string, enabled: boolean) {
  database.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`tool_enabled:${name}`,enabled?'1':'0',nowIso());
}
export type ToolPolicy = 'default' | 'auto' | 'confirm';
export function toolPolicy(name: string): ToolPolicy {
  const value=(database.prepare('SELECT value FROM app_settings WHERE key=?').get(`tool_policy:${name}`) as {value:string}|undefined)?.value;
  return value==='auto'||value==='confirm'?value:'default';
}
export function saveToolPolicy(name: string, policy: ToolPolicy) {
  if(!['default','auto','confirm'].includes(policy)) throw Object.assign(new Error('执行策略无效。'),{statusCode:400});
  database.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`tool_policy:${name}`,policy,nowIso());
}
export function controlledTool<T>(name: string, execute: () => T, confirmed=false): T {
  ensureStore();
  const start=Date.now();
  const record=(status:string,error:string|null=null)=>database.prepare('INSERT INTO capability_tool_runs VALUES (?,?,?,?,?,?)').run(randomUUID(),name,status,Date.now()-start,error,nowIso());
  if (!toolEnabled(name)) { record('blocked','工具已停用'); throw Object.assign(new Error('这个工具已在能力中心停用，请先启用后再试。'),{statusCode:403}); }
  if (toolPolicy(name)==='confirm'&&!confirmed) { record('blocked','需要确认'); throw Object.assign(new Error('这个工具需要确认后执行。'),{statusCode:409}); }
  try { const result=execute();
    if(result && typeof (result as unknown as Promise<unknown>).then==='function') return Promise.resolve(result).then(value=>{record('succeeded');return value;},error=>{record('failed',name.startsWith('mcp_')?'MCP 调用失败，请检查连接或参数。':error instanceof Error?error.message.slice(0,500):'工具执行失败');throw error;}) as T;
    record('succeeded'); return result; }
  catch(error) { record('failed',error instanceof Error?error.message.slice(0,500):'工具执行失败'); throw error; }
}
export function listToolRuns() {
  ensureStore();
  return database.prepare('SELECT id,tool_name AS toolName,status,elapsed_ms AS elapsedMs,error,created_at AS createdAt FROM capability_tool_runs ORDER BY rowid DESC LIMIT 100').all();
}
