import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import express from 'express';

test('安装自动检查可持久化、标记过期，且不会真实执行技能工具',async context=>{
  const directory=mkdtempSync(join(tmpdir(),'xiwei-skill-health-'));
  process.env.AI_SECRETARY_DB_PATH=join(directory,'test.db');
  process.env.AI_SECRETARY_SKILLS_DIR=join(directory,'skills');
  process.env.AI_SECRETARY_SECRET_DIRECTORY=join(directory,'secrets');
  const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();
  const {registerSkillRoutes}=await import('../../api/skills.js');
  const {saveToolEnabled}=await import('./tool-controls.js');
  let modelCalls=0,analysis:'valid'|'invalid'|'concurrent'='valid';
  const app=express();app.use(express.json());
  registerSkillRoutes(app,{requestSignal:()=>new AbortController().signal,canUseModel:()=>true,complete:async()=>{
    modelCalls++;
    if(analysis==='concurrent')saveToolEnabled('get_document',false);
    return analysis==='invalid'?'invalid model response':JSON.stringify({tools:['list_projects'],missingCapabilities:[]});
  }});
  app.use((error:any,_request:any,response:any,_next:any)=>response.status(error.statusCode??500).json({message:error.message}));
  const server=await new Promise<ReturnType<typeof app.listen>>(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  context.after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));database.close();assert.equal(dirname(directory),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});});
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/api`;
  async function request(path:string,method='GET',body?:unknown){const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(response.ok,await response.clone().text());return response.json();}
  assert.deepEqual(await request('/skills/tool-runs'),[]);
  const saved=await request('/skills/build','POST',{name:'health-preview',description:'整理会议结论',instructions:'根据会议内容提取结论，不执行其他操作。',generate:false});
  assert.equal(saved.installed,true);assert.equal(saved.health.status,'dependencies_available');assert.equal(modelCalls,1);
  assert.deepEqual(await request('/skills/tool-runs'),[],'自动检查没有真实调用任何工具');
  let skills=await request('/skills');assert.equal(skills.find((skill:any)=>skill.id===saved.id).health.stale,false);
  saveToolEnabled('list_projects',false);
  skills=await request('/skills');assert.equal(skills.find((skill:any)=>skill.id===saved.id).health.stale,true);
  const blocked=await request(`/skills/${saved.id}/check`,'POST',{});assert.equal(blocked.status,'blocked');
  saveToolEnabled('list_projects',true);analysis='invalid';
  const incomplete=await request(`/skills/${saved.id}/check`,'POST',{});assert.equal(incomplete.analysisStatus,'failed');assert.equal(incomplete.status,'needs_review');
  analysis='concurrent';const raced=await request(`/skills/${saved.id}/check`,'POST',{});assert.equal(raced.stale,true,'检查期间配置变化不会被记录成当前检查通过');
  skills=await request('/skills');assert.equal(skills.find((skill:any)=>skill.id===saved.id).health.stale,true);
  assert.deepEqual(await request('/skills/tool-runs'),[]);
});
