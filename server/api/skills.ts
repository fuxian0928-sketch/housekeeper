import { listUncertainToolCalls, reconcileToolCall } from '../domain/skills/external-tool-guard.js';
import type { Express } from 'express';
import {listHttpTools,saveHttpTool,deleteHttpTool} from '../domain/skills/http-tools.js';
import {saveSkillRequirements,skillRequirements,runSkillWorkbench,skillWorkbenchRuns,resumeSkillWorkbench} from '../domain/skills/skill-workbench.js';
import { inspectGitHubRepository, readGitHubFile } from '../domain/github/github-reader.js';
import { buildManagedSkill, generateManagedSkillContent, installManagedSkill, listManagedSkills, setManagedSkillEnabled, uninstallManagedSkill, updateManagedSkill,resolveManagedSkillInstructions } from '../domain/skills/skill-manager.js';
import { getSkillTool, listSkillTools, executeSkillTool } from '../domain/skills/skill-tool-registry.js';
import { listToolRuns, saveToolEnabled, saveToolPolicy, toolPolicy } from '../domain/skills/tool-controls.js';
import { listMcpConnections, saveMcpConnection, setMcpEnabled, deleteMcpConnection, discoverMcpTools } from '../domain/skills/mcp-connections.js';
import { listSkillRevisions, rollbackSkillRevision } from '../domain/skills/skill-manager.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listSkillExecutions } from '../domain/skills/skill-execution-audit.js';
import {checkSkillHealth,readSkillHealthChecks} from '../domain/skills/skill-health.js';

type Dependencies = {
  requestSignal: (request: any, response: any) => AbortSignal;
  canUseModel: () => boolean;
  complete: (input: string, options: { instruction: string; maxTokens: number }) => Promise<string>;
};
function statusCode(error: unknown) { return Number((error as { statusCode?: number }).statusCode ?? 500); }

export function registerSkillRoutes(app: Express, dependencies: Dependencies) {
  async function installedWithHealth<T extends {installed:boolean}>(result:T) {
    if(!result.installed||!('id' in result)||typeof result.id!=='string')return result;
    try{return {...result,health:await checkSkillHealth(result.id,dependencies.canUseModel()?dependencies.complete:undefined)};}
    catch{return {...result,health:null,healthError:'技能已安装，自动检查暂未完成，可在技能详情中重试。'};}
  }
  app.get('/api/capabilities/uncertain',(_q,r)=>r.json(listUncertainToolCalls()));
  app.post('/api/capabilities/uncertain/resolve',(q,r,next)=>{try{r.json(reconcileToolCall(q.body??{}));}catch(e){next(e);}});
  app.get('/api/capabilities/http',(_q,r)=>r.json(listHttpTools()));
  app.post('/api/skills/draft',async(q,r,next)=>{try{if(!dependencies.canUseModel())throw Object.assign(new Error('请先配置对话模型。'),{statusCode:400});r.json({content:await generateManagedSkillContent({name:String(q.body.name??''),description:String(q.body.description??''),instructions:String(q.body.instructions??'')},dependencies.complete)});}catch(e){next(e);}});
  app.post('/api/capabilities/http',(q,r,next)=>{try{r.status(201).json(saveHttpTool(q.body));}catch(e){next(e);}});
  app.put('/api/capabilities/http/:id',(q,r,next)=>{try{r.json(saveHttpTool(q.body,q.params.id));}catch(e){next(e);}});
  app.delete('/api/capabilities/http/:id',(q,r,next)=>{try{deleteHttpTool(q.params.id);r.json({ok:true});}catch(e){next(e);}});
  app.get('/api/skills/:id/requirements',(q,r)=>r.json(skillRequirements(q.params.id)));
  app.put('/api/skills/:id/requirements',(q,r,next)=>{try{r.json(saveSkillRequirements(q.params.id,q.body.tools));}catch(e){next(e);}});
  app.post('/api/skills/:id/check',async(q,r,next)=>{try{r.json(await checkSkillHealth(q.params.id,dependencies.canUseModel()?dependencies.complete:undefined));}catch(e){next(e);}});
  app.post('/api/skills/:id/trigger-test',async(q,r,next)=>{try{
    if(!dependencies.canUseModel())throw Object.assign(new Error('请先配置可用的对话模型。'),{statusCode:400});
    const message=String(q.body.message??'').trim();if(!message||message.length>12000)throw Object.assign(new Error('请输入具体请求，最多12000字。'),{statusCode:400});
    const selected=await resolveManagedSkillInstructions(message,dependencies.complete);
    r.json({matched:selected.skills.some(s=>s.id===q.params.id),selected:selected.skills.map(s=>s.name),notice:'这是工作流程中的技能选择测试，不执行任何工具。自动识别模式还需先判断本轮是否属于工作。'});
  }catch(e){next(e);}});
  app.get('/api/skills/:id/runs',(q,r)=>r.json(skillWorkbenchRuns(q.params.id)));
  app.post('/api/skills/:id/runs/:runId/resume',async(q,r,next)=>{try{if(!dependencies.canUseModel())throw Object.assign(new Error('请先配置可用的对话模型。'),{statusCode:400});r.json(await resumeSkillWorkbench(q.params.id,q.params.runId,dependencies.complete));}catch(e){next(e);}});
  app.post('/api/skills/:id/run',async(q,r,next)=>{try{if(!dependencies.canUseModel())throw Object.assign(new Error('请先配置可用的对话模型。'),{statusCode:400});r.json(await runSkillWorkbench(q.params.id,q.body,dependencies.complete));}catch(e){next(e);}});
  app.get('/api/capabilities/mcp',(_q,r)=>r.json(listMcpConnections()));
  app.post('/api/capabilities/mcp',(q,r,next)=>{try{r.status(201).json(saveMcpConnection(q.body));}catch(e){next(e);}});
  app.put('/api/capabilities/mcp/:id',(q,r,next)=>{try{r.json(saveMcpConnection(q.body,q.params.id));}catch(e){next(e);}});
  app.patch('/api/capabilities/mcp/:id/enabled',(q,r,next)=>{try{if(typeof q.body?.enabled!=='boolean')throw Object.assign(new Error('启用状态无效。'),{statusCode:400});setMcpEnabled(q.params.id,q.body.enabled);r.json({ok:true});}catch(e){next(e);}});
  app.delete('/api/capabilities/mcp/:id',(q,r,next)=>{try{deleteMcpConnection(q.params.id);r.json({ok:true});}catch(e){next(e);}});
  app.post('/api/capabilities/mcp/:id/test',async(q,r,next)=>{try{r.json(await discoverMcpTools(q.params.id));}catch(e){next(e);}});
  app.patch('/api/skills/tools/:name/policy',(q,r,next)=>{try{if(!getSkillTool(q.params.name))throw Object.assign(new Error('工具不存在。'),{statusCode:404});saveToolPolicy(q.params.name,q.body?.policy);r.json({ok:true});}catch(e){next(e);}});
  app.post('/api/capabilities/test',async(q,r,next)=>{try{
    const name=String(q.body?.tool??''),tool=getSkillTool(name);
    if(!tool)throw Object.assign(new Error('工具不存在。'),{statusCode:404});
    if((tool.mode==='write'||toolPolicy(name)==='confirm')&&q.body?.confirm!==true){r.status(409).json({message:'该测试会实际调用工具，请勾选确认后执行。'});return;}
    const result=await executeSkillTool(name,q.body?.arguments??{},{vaultPath:'central://documents',projectId:typeof q.body?.projectId==='string'?q.body.projectId:null,confirmed:q.body?.confirm===true});
    const text=JSON.stringify(result);r.json({result:text.length<=60000?result:text.slice(0,60000),truncated:text.length>60000});
  }catch(e){next(e);}});
  app.get('/api/skills/:id/versions',async(q,r,next)=>{try{r.json(await listSkillRevisions(q.params.id));}catch(e){next(e);}});
  app.post('/api/skills/:id/rollback',async(q,r,next)=>{try{r.json(await rollbackSkillRevision(q.params.id,String(q.body?.revisionId??'')));}catch(e){next(e);}});
  app.post('/api/github/inspect', async (request, response) => {
    try { response.json(await inspectGitHubRepository(String(request.body?.url ?? ''), dependencies.requestSignal(request, response))); }
    catch (error) { response.status(statusCode(error)).json({ message: error instanceof Error ? error.message : 'GitHub 仓库读取失败。' }); }
  });
  app.post('/api/github/read', async (request, response) => {
    try { response.json(await readGitHubFile(String(request.body?.url ?? ''), typeof request.body?.path === 'string' ? request.body.path : undefined, dependencies.requestSignal(request, response))); }
    catch (error) { response.status(statusCode(error)).json({ message: error instanceof Error ? error.message : 'GitHub 文件读取失败。' }); }
  });
  app.get('/api/skills', (_request, response) => {const checks=readSkillHealthChecks();response.json(listManagedSkills().map(skill=>({...skill,health:checks.get(skill.id)??null})));});
  app.get('/api/skills/tools', (_request, response) => {
    const titles=new Map(listHttpTools().map(tool=>[tool.toolName,tool.name]));
    response.json(listSkillTools().map(tool=>({...tool,displayName:titles.get(tool.name)})));
  });
  app.patch('/api/skills/tools/:name/enabled', (request, response) => {
    if (!getSkillTool(request.params.name)) { response.status(404).json({message:'工具不存在。'}); return; }
    if (typeof request.body?.enabled !== 'boolean') { response.status(400).json({message:'请选择启用或停用。'}); return; }
    saveToolEnabled(request.params.name, request.body.enabled);
    response.json({ok:true});
  });
  app.get('/api/skills/tool-runs', (_request,response) => response.json(listToolRuns()));
  app.get('/api/skills/:id/content', async (request,response) => {
    const skill=listManagedSkills().find(skill=>skill.id===request.params.id);
    if(!skill) { response.status(404).json({message:'技能不存在。'}); return; }
    try { response.json({content:await readFile(join(skill.installPath,'SKILL.md'),'utf8')}); }
    catch { response.status(404).json({message:'技能文件无法读取。'}); }
  });
  app.get('/api/skills/executions', (request, response) => response.json(listSkillExecutions(Number(request.query.limit) || 100)));
  app.post('/api/skills/install', async (request, response) => {
    try {
      const result = await installManagedSkill(String(request.body?.url ?? ''), request.body?.allowRisky === true, dependencies.requestSignal(request, response));
      response.status(result.installed ? 201 : 202).json(await installedWithHealth(result));
    } catch (error) { response.status(statusCode(error)).json({ message: error instanceof Error ? error.message : '技能安装失败。' }); }
  });
  app.post('/api/skills/build', async (request, response) => {
    try {
      const input = { name: String(request.body?.name ?? ''), description: String(request.body?.description ?? ''), instructions: String(request.body?.instructions ?? '') };
      const content = request.body?.generate !== false && dependencies.canUseModel() ? await generateManagedSkillContent(input, dependencies.complete) : undefined;
      response.status(201).json(await installedWithHealth(await buildManagedSkill({ ...input, content, replace: request.body?.replace === true })));
    }
    catch (error) { response.status(statusCode(error)).json({ message: error instanceof Error ? error.message : '技能创建失败。' }); }
  });
  app.post('/api/skills/:id/update', async (request, response) => {
    try {
      const result = await updateManagedSkill(request.params.id, request.body?.allowRisky === true, dependencies.requestSignal(request, response));
      response.status(result.installed ? 200 : 202).json(await installedWithHealth(result));
    } catch (error) { response.status(statusCode(error)).json({ message: error instanceof Error ? error.message : '技能更新失败。' }); }
  });
  app.patch('/api/skills/:id/enabled', (request, response) => {
    try { response.json(setManagedSkillEnabled(request.params.id, request.body?.enabled === true)); }
    catch (error) { response.status(statusCode(error)).json({ message: error instanceof Error ? error.message : '技能状态修改失败。' }); }
  });
  app.delete('/api/skills/:id', async (request, response) => {
    try { response.json(await uninstallManagedSkill(request.params.id)); }
    catch (error) { response.status(statusCode(error)).json({ message: error instanceof Error ? error.message : '技能卸载失败。' }); }
  });
}
