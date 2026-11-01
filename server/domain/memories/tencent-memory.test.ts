import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('腾讯记忆读取适配器遵守隔离、候选标记、超时和故障退避',async context=>{
  process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'xiwei-tencent-memory-')),'test.db');
  const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();
  context.after(()=>database.close());
  const {TencentMemoryReader,tencentMemoryFromEnvironment}=await import('./tencent-memory.js');
  const {AgentMemoryCoordinator}=await import('./agent-memory-coordinator.js');
  let handle:(request:IncomingMessage,response:ServerResponse)=>void=(_req,res)=>res.end('{}'),requests=0;
  const server=createServer((req,res)=>{requests++;handle(req,res);});server.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));context.after(()=>{server.closeAllConnections();server.close();});
  const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const config={endpoint,apiKey:'fixture-only-key',serviceId:'fixture-service',teamId:'fixture-team',agentId:'xiwei',userId:'fixture-user'};
  const json=(response:ServerResponse,value:unknown)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify(value));};

  await context.test('默认关闭；缺失字段和无效配置只返回错误代码',()=>{
    assert.equal(tencentMemoryFromEnvironment({}).reader,null);
    assert.match(tencentMemoryFromEnvironment({AI_SECRETARY_MEMORY_TENCENT_ENDPOINT:endpoint}).configurationError??'',/^TENCENT_MEMORY_MISSING_/);
    const invalid=tencentMemoryFromEnvironment({AI_SECRETARY_MEMORY_TENCENT_ENDPOINT:'invalid-private-address'});
    assert.equal(invalid.configurationError,'TENCENT_MEMORY_MISSING_APIKEY');
    assert.throws(()=>new TencentMemoryReader({...config,endpoint:'http://external.invalid'}),/HTTPS_REQUIRED/);
    assert.throws(()=>new TencentMemoryReader({...config,endpoint:'https://user:secret@example.invalid'}),/ENDPOINT_INVALID/);
  });
  await context.test('v3 请求携带明确用户和项目范围，结果保持未核实',async()=>{
    let body:any=null,authorization='',service='';
    handle=(req,res)=>{authorization=String(req.headers.authorization);service=String(req.headers['x-tdai-service-id']);let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{body=JSON.parse(text);json(res,{code:0,data:{items:[{id:'hit',content:'偏好：api_key=fixture-private-secret，喜欢简洁回答',updated_at:'2026-10-25T00:00:00Z'},{id:'invalid',content:9}]}});});};
    const reader=new TencentMemoryReader(config),items=await reader.recall('查询偏好 password=fixture-user-secret','p1');
    assert.equal(authorization,'Bearer fixture-only-key');assert.equal(service,'fixture-service');
    assert.equal(body.team_id,'fixture-team');assert.equal(body.agent_id,'xiwei');assert.equal(body.user_id,'fixture-user');assert.equal(body.task_id,'xiwei-project:p1');
    assert.ok(!body.query.includes('fixture-user-secret'));assert.equal(items.length,1);assert.equal(items[0].projectId,'p1');assert.equal(items[0].verification,'unverified');assert.equal(items[0].requiresSourceCheck,true);assert.ok(!items[0].content.includes('fixture-private-secret'));
    await reader.recall('偏好',null);assert.equal(body.task_id,'xiwei-personal');assert.equal(reader.status().connected,true);assert.equal(reader.status().captureEnabled,false);
    const before=requests,coordinator=new AgentMemoryCoordinator({embedding:()=>null,tencent:reader});
    await coordinator.build('你好',null);assert.equal(requests,before,'greetings must skip external lookup');
  });
  await context.test('HTTP成功不等于协议成功；连续失败后停止重复请求',async()=>{
    handle=(_req,res)=>json(res,{code:500,message:'provider private message',data:{items:[]}});
    const reader=new TencentMemoryReader(config);
    for(let index=0;index<3;index++)await assert.rejects(reader.recall('偏好',null),/PROTOCOL_MISMATCH/);
    const before=requests;assert.equal(reader.status().circuitOpen,true);assert.equal(reader.status().connected,false);
    await assert.rejects(reader.recall('偏好',null),/CIRCUIT_OPEN/);assert.equal(requests,before);assert.ok(!JSON.stringify(reader.status()).includes('provider private message'));
  });
  await context.test('重定向不会把认证信息发往其他入口',async()=>{
    handle=(_req,res)=>{res.writeHead(302,{Location:`${endpoint}/redirect-target`});res.end();};
    const before=requests;await assert.rejects(new TencentMemoryReader(config).recall('偏好',null),/UNAVAILABLE/);assert.equal(requests,before+1);
  });
  await context.test('独立超时与取消不拖住前台轮次',async()=>{
    handle=()=>{};
    const reader=new TencentMemoryReader({...config,timeoutMs:50}),started=Date.now();
    await assert.rejects(reader.recall('偏好',null),/UNAVAILABLE/);assert.ok(Date.now()-started<1500);
    const abort=new AbortController(),pending=reader.recall('偏好',null,abort.signal);abort.abort();await assert.rejects(pending,{name:'AbortError'});
  });
});
