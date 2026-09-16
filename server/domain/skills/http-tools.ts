import {randomUUID} from 'node:crypto';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import {database} from '../../db.js';
import {sealCapabilitySecret,unsealCapabilitySecret} from './mcp-connections.js';
import type {SkillToolDefinition} from './skill-tool-registry.js';
const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
type HttpTool={id:string;name:string;description:string;url:string;method:string;schema_json:string;secret:string;revision:number};
function store(){database.exec(`CREATE TABLE IF NOT EXISTS custom_http_tools(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,url TEXT NOT NULL,method TEXT NOT NULL,schema_json TEXT NOT NULL,secret TEXT NOT NULL,revision INTEGER NOT NULL)`);}
function rows(){store();return database.prepare('SELECT * FROM custom_http_tools ORDER BY rowid').all() as HttpTool[];}
function toolName(t:HttpTool){return `http_${t.id}_v${t.revision}`;}
export function listHttpTools(){return rows().map(({secret,schema_json,...t})=>({...t,toolName:toolName(t as HttpTool),hasToken:!!secret,schema:JSON.parse(schema_json)}));}
export function saveHttpTool(input:Record<string,unknown>,id?:string){
 const old=id?rows().find(t=>t.id===id):undefined;store();if(id&&!old)throw fail('工具不存在。',404);
 const name=String(input.name??'').trim(),description=String(input.description??'').trim();
 if(!name||name.length>80||!description||description.length>1000)throw fail('请填写工具名称和用途（最多80／1000字）。');
 let url:URL;try{url=new URL(String(input.url));}catch{throw fail('服务地址无效。');}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw fail('请填写HTTP(S)地址，认证放在令牌栏，参数通过JSON传入。');
 const method=String(input.method);if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))throw fail('请求方法无效。');
 const schema=input.schema;if(!schema||typeof schema!=='object'||Array.isArray(schema)||(schema as {type?:string}).type!=='object'||JSON.stringify(schema).length>20000)throw fail('参数定义必须是object类型的JSON Schema。');
 try{new AjvJsonSchemaValidator().getValidator(schema as Record<string,unknown>);}catch{throw fail('参数Schema无法编译。');}
 const token=input.token;if(token!==undefined&&(typeof token!=='string'||token.length>8192||/[\r\n]/.test(token)))throw fail('令牌格式错误。');
 const secret=input.clearToken===true?'':token?sealCapabilitySecret(String(token)):old?.secret??'';
 const key=old?.id??randomUUID().replaceAll('-','');
 database.prepare(`INSERT INTO custom_http_tools VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,url=excluded.url,method=excluded.method,schema_json=excluded.schema_json,secret=excluded.secret,revision=excluded.revision`).run(key,name,description,url.href,method,JSON.stringify(schema),secret,(old?.revision??0)+1);
 return listHttpTools().find(t=>t.id===key)!;
}
export function deleteHttpTool(id:string){store();database.prepare('DELETE FROM custom_http_tools WHERE id=?').run(id);}
export function httpToolDefinitions():SkillToolDefinition[]{return rows().map(t=>({name:toolName(t),description:`${t.name} · ${t.description}`,mode:'write',permission:'http.execute',riskLevel:'medium',parameters:t.schema_json}));}
export async function callHttpTool(name:string,args:Record<string,unknown>){
 const tool=rows().find(t=>toolName(t)===name);if(!tool)throw fail('工具已修改或删除，请重新生成执行计划。',409);
 if(!new AjvJsonSchemaValidator().getValidator(JSON.parse(tool.schema_json))(args).valid)throw fail('参数不符合工具Schema，请检查必填项和类型。');
 const url=new URL(tool.url),headers:Record<string,string>={Accept:'application/json'};
 const token=unsealCapabilitySecret(tool.secret);if(token)headers.Authorization=`Bearer ${token}`;
 let body:string|undefined;
 if(tool.method==='GET'){for(const [k,v] of Object.entries(args))url.searchParams.set(k,typeof v==='object'?JSON.stringify(v):String(v));}
 else{headers['Content-Type']='application/json';body=JSON.stringify(args);}
 const response=await fetch(url,{method:tool.method,headers,body,redirect:'error',signal:AbortSignal.timeout(20000)}).catch(()=>{throw fail('HTTP工具连接失败或超时，请检查地址与服务状态。',502);});
 if(!response.ok)throw fail(`HTTP工具返回状态码 ${response.status}，请检查认证或请求参数。`,502);
 const reader=response.body?.getReader();let length=0;const chunks:Uint8Array[]=[];
 if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>1000000)throw fail('响应超过1MB，请缩小查询范围。',413);chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const text=Buffer.concat(chunks).toString('utf8');try{return JSON.parse(text);}catch{return {text};}
}
