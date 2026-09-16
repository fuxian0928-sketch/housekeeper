import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { database, databaseDirectory, nowIso } from '../../db.js';
import type { SkillToolDefinition } from './skill-tool-registry.js';

type RemoteTool = {name:string;description?:string;inputSchema:Record<string,unknown>;annotations?:{readOnlyHint?:boolean}};
export { seal as sealCapabilitySecret, unseal as unsealCapabilitySecret };
type Connection = {id:string;name:string;url:string;transport:'http'|'sse';secret:string;enabled:number;tools_json:string;checked_at:string|null};
const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
function prefix(row:Connection){return `mcp_${row.id}_${createHash('sha256').update(row.url+'|'+row.transport+'|'+row.secret).digest('hex').slice(0,8)}__`;}
function store(){database.exec(`CREATE TABLE IF NOT EXISTS mcp_connections(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,transport TEXT NOT NULL,secret TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,tools_json TEXT NOT NULL DEFAULT '[]',checked_at TEXT)`);}
function secretKey(){const path=join(databaseDirectory,'mcp-secret.key');if(!existsSync(path)){try{writeFileSync(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if(!existsSync(path))throw error;}}return readFileSync(path);}
function seal(value:string){if(!value)return '';const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secretKey(),iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
function unseal(value:string){if(!value)return '';const b=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',secretKey(),b.subarray(0,12));decipher.setAuthTag(b.subarray(12,28));return Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString('utf8');}
function rows(){store();return database.prepare('SELECT * FROM mcp_connections ORDER BY rowid').all() as Connection[];}
function find(id:string){const row=rows().find(r=>r.id===id);if(!row)throw fail('MCP 连接不存在。',404);return row;}
export function listMcpConnections(){return rows().map(r=>({id:r.id,name:r.name,url:r.url,transport:r.transport,enabled:!!r.enabled,hasToken:!!r.secret,toolCount:JSON.parse(r.tools_json).length,checkedAt:r.checked_at}));}
export function saveMcpConnection(input:Record<string,unknown>,id?:string){
  store();const old=id?find(id):undefined;
  const name=String(input.name??'').trim();let url:URL;try{url=new URL(String(input.url??''));}catch{throw fail('MCP 服务地址格式不正确。');}
  if(!name||name.length>80)throw fail('请填写 1–80 字的连接名称。');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw fail('请填写 HTTP(S) MCP 地址；密钥请放在令牌字段，不要放在网址里。');
  if(!['http','sse'].includes(String(input.transport)))throw fail('请选择 Streamable HTTP 或 SSE。');
  if(input.token!==undefined&&(typeof input.token!=='string'||input.token.length>8192||/[\r\n]/.test(input.token)))throw fail('令牌格式无效。');
  const secret=input.clearToken===true?'':input.token?seal(String(input.token)):old?.secret??'';
  const key=old?.id??randomUUID().replaceAll('-','');
  // Reconfiguration invalidates the catalog so old proposals cannot target a different server.
  database.prepare(`INSERT INTO mcp_connections(id,name,url,transport,secret) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,transport=excluded.transport,secret=excluded.secret,tools_json='[]',checked_at=NULL`).run(key,name,url.href,input.transport as string,secret);
  return listMcpConnections().find(r=>r.id===key)!;
}
export function setMcpEnabled(id:string,enabled:boolean){find(id);database.prepare('UPDATE mcp_connections SET enabled=? WHERE id=?').run(enabled?1:0,id);}
export function deleteMcpConnection(id:string){find(id);database.prepare('DELETE FROM mcp_connections WHERE id=?').run(id);database.prepare("DELETE FROM app_settings WHERE key LIKE ? OR key LIKE ?").run(`tool_enabled:mcp_${id}_%`,`tool_policy:mcp_${id}_%`);}
async function connected<T>(row:Connection,work:(client:Client,signal:AbortSignal)=>Promise<T>){
  if(!row.enabled)throw fail('MCP 连接已停用。',403);
  const signal=AbortSignal.timeout(20000),token=unseal(row.secret);
  const headers:Record<string,string>=token?{Authorization:`Bearer ${token}`} : {};
  const origin=new URL(row.url).origin;
  const boundedFetch:typeof fetch=(input,init)=>{
    const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(target.origin!==origin)throw fail('MCP 连接不能跳转到其他服务器。');
    return fetch(input,{...init,redirect:'error',signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});
  };
  const transport=row.transport==='sse'?new SSEClientTransport(new URL(row.url),{requestInit:{headers},fetch:boundedFetch}):new StreamableHTTPClientTransport(new URL(row.url),{requestInit:{headers},fetch:boundedFetch,reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
  const client=new Client({name:'ai-secretary',version:'1.2.12'});
  try{await client.connect(transport,{signal,timeout:20000});return await work(client,signal);}
  catch(error){if((error as {statusCode?:number}).statusCode)throw error;throw fail('MCP 请求失败或超时，请检查地址、协议、令牌及服务是否在线。',502);}
  finally{await client.close().catch(()=>{});}
}
export async function discoverMcpTools(id:string){const row=find(id);return connected(row,async(client,signal)=>{
  const tools:RemoteTool[]=[];let cursor:string|undefined;
  for(let page=0;page<10;page++){const result=await client.listTools(cursor?{cursor}:undefined,{signal,timeout:20000});tools.push(...result.tools as RemoteTool[]);cursor=result.nextCursor;if(!cursor)break;}
  if(cursor||tools.length>200)throw fail('工具目录超过 200 项，请拆分 MCP 服务。');
  if(tools.some(t=>!t.name||t.name.length>128)||new Set(tools.map(t=>t.name)).size!==tools.length)throw fail('MCP 工具目录名称无效或重复。');
  if(JSON.stringify(tools).length>500000)throw fail('MCP 工具目录过大。');
  // Do not resurrect a connection changed or removed while discovery was in flight.
  const current=find(id);if(current.url!==row.url||current.secret!==row.secret||current.transport!==row.transport||!current.enabled)throw fail('连接已变更，请重新测试。',409);
  database.prepare('UPDATE mcp_connections SET tools_json=?,checked_at=? WHERE id=?').run(JSON.stringify(tools),nowIso(),id);
  return {toolCount:tools.length};
});}
export function mcpToolDefinitions():SkillToolDefinition[]{return rows().filter(r=>r.enabled).flatMap(row=>(JSON.parse(row.tools_json) as RemoteTool[]).map(t=>({name:prefix(row)+t.name,description:`${row.name} · ${(t.description??t.name).slice(0,1000)}`,mode:'write' as const,permission:'mcp.execute',riskLevel:'medium' as const,parameters:JSON.stringify(t.inputSchema)})));}
export async function callMcpTool(name:string,args:Record<string,unknown>){
  const row=rows().find(r=>name.startsWith(prefix(r)));if(!row||!row.enabled)throw fail('MCP 连接不可用或配置已变更。',403);
  const remoteName=name.slice(prefix(row).length);
  const tool=(JSON.parse(row.tools_json) as RemoteTool[]).find(t=>t.name===remoteName);
  if(!tool)throw fail('MCP 工具已变更，请刷新工具目录。',409);
  let valid=false;try{valid=new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid;}catch{throw fail('MCP 参数定义无法验证，请联系服务提供者。');}
  if(!valid)throw fail('参数不符合该 MCP 工具的 JSON Schema，请检查必填项和类型。');
  return connected(row,async(client,signal)=>{const result=await client.callTool({name:remoteName,arguments:args},undefined,{signal,timeout:20000});if(result.isError)throw fail('MCP 工具返回失败，请检查参数或服务端状态。',502);return result;});
}
