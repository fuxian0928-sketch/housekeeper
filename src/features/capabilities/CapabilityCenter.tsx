import { StyledSelect } from './../../components/ui';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import './capabilities.css';
import { HttpTools, SkillWorkbench } from './LifecyclePanels';
import { ToolParameters } from './ToolParameters';
import { McpConnections, ToolTestBench, SkillVersions } from './HarnessExtensions';

type Skill = {id:string;name:string;description:string;enabled:boolean;sourceType:string;status:string;version:string};
type Tool = {name:string;description:string;mode:string;enabled:boolean;parameters:string;policy:string};
type Run = {id:string;toolName:string;status:string;elapsedMs:number;error:string|null;createdAt:string};
const emptyDraft = {name:'',description:'',instructions:''};
export function CapabilityCenter() {
  const panel=useRef<HTMLElement>(null);
  const [tab,setTab]=useState<'skills'|'tools'|'runs'|'mcp'|'test'>('skills');
  const [testSkill,setTestSkill]=useState('');
  const [versionSkill,setVersionSkill]=useState<string|null>(null);
  const [skills,setSkills]=useState<Skill[]>([]),[tools,setTools]=useState<Tool[]>([]),[runs,setRuns]=useState<Run[]>([]);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [draft,setDraft]=useState(emptyDraft),[editor,setEditor]=useState(false),[editing,setEditing]=useState(false);
  const [url,setUrl]=useState('');
  const [toolSearch,setToolSearch]=useState('');
  useEffect(()=>{if(editor) panel.current?.scrollTo({top:0});},[editor]);
  useEffect(()=>{panel.current?.scrollTo({top:0});},[tab]);
  const [review,setReview]=useState<{url:string;permissions:string[]} | null>(null);
  async function refresh() {
    const [s,t,r]=await Promise.all([api.get<Skill[]>('/skills'),api.get<Tool[]>('/skills/tools'),api.get<Run[]>('/skills/tool-runs')]);
    setSkills(s.filter(skill=>skill.status==='installed'));setTools(t);setRuns(r);
  }
  useEffect(()=>{let active=true; Promise.all([api.get<Skill[]>('/skills'),api.get<Tool[]>('/skills/tools'),api.get<Run[]>('/skills/tool-runs')]).then(([s,t,r])=>{if(active){setSkills(s.filter(skill=>skill.status==='installed'));setTools(t);setRuns(r);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  async function action(work:()=>Promise<unknown>,message:string) {
    setBusy(true);setError('');setNotice('');
    try {await work();await refresh();setNotice(message);} catch(e){setError(e instanceof Error?e.message:'操作失败，请重试。');}finally{setBusy(false);}
  }
  async function install(allowRisky=false) {
    const target=allowRisky?review?.url:url.trim();
    await action(async()=>{
      const result=await api.post<{installed:boolean;permissions?:string[]}>('/skills/install',{url:target,allowRisky});
      if(!result.installed){setReview({url:target!,permissions:result.permissions??[]});return;}
      setReview(null);setUrl('');
    },'');
  }
  return <section ref={panel} className="settings-form subpage-panel capability-center">
    <div className="settings-heading"><div><h2>能力中心</h2><p>管理技能、工具与外部服务。配置在各客户端间共享。</p></div><button className="secondary-button" type="button" disabled={busy||loading} onClick={()=>void action(refresh,'已刷新')}>刷新</button></div>
    <nav className="subpage-nav" aria-label="能力中心分类">{([['skills','技能'],['tools','工具'],['mcp','MCP 连接'],['test','测试台'],['runs','执行记录']] as const).map(([id,label])=><button key={id} type="button" aria-current={tab===id?'page':undefined} className={tab===id?'active':''} onClick={()=>{setTab(id);setNotice('');setError('');panel.current?.scrollTo({top:0});}}>{label}</button>)}</nav>
    {error&&<p role="alert" className="cap-error">{error} <button className="secondary-button" type="button" disabled={busy} onClick={()=>void action(refresh,'已重新加载')}>重新加载</button></p>}
    {notice&&<p role="status" className="cap-notice">{notice}</p>}
    {loading?<p role="status">正在加载能力配置…</p>:<>
      {tab==='mcp'&&<McpConnections tools={tools} onChange={refresh}/>}
      {tab==='test'&&<><SkillWorkbench initialId={testSkill} skills={skills} tools={tools}/><ToolTestBench tools={tools} onChange={refresh}/></>}
      {tab==='skills'&&<div>
        <div className="cap-toolbar"><div><h3>已安装技能 <span className="cap-meta">{skills.length}</span></h3><p>定义小E在特定场景下的工作规则。</p></div><button className="primary-button" type="button" disabled={busy} onClick={()=>{setEditor(true);setEditing(false);setDraft(emptyDraft);}}>新建技能</button></div>
        {editor&&<form className="cap-editor" onSubmit={e=>{e.preventDefault();void action(async()=>{const saved=await api.post<{id:string}>('/skills/build',{...draft,generate:false,replace:editing});setEditor(false);setTestSkill(saved.id);setTab('test');},'技能已保存并启用。请检查依赖，再用具体请求验证。');}}>
          <h3>{editing?'编辑技能':'新建技能'}</h3>
          <div className="cap-form-grid"><label>技能名称<input placeholder="例如：会议行动项整理" required maxLength={64} readOnly={editing} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
          <label>适用场景<input placeholder="例如：会议结束后，整理待办任务" required maxLength={500} value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})}/></label></div>
          <button className="secondary-button" type="button" disabled={busy||!draft.name.trim()||!draft.description.trim()} onClick={()=>void action(async()=>{const generated=await api.post<{content:string}>('/skills/draft',draft);setDraft({...draft,instructions:generated.content.replace(/^---[\s\S]*?---\s*/,'')});},'已生成草稿，请检查规则后保存。')}>根据描述生成草稿</button><label>执行规则<textarea required rows={9} maxLength={12000} value={draft.instructions} onChange={e=>setDraft({...draft,instructions:e.target.value})} placeholder="例如：读取会议记录，提取明确的行动项。匹配已有项目；项目不明确时追问。调用任务创建工具后，根据实际结果报告。"/></label>
          <div className="cap-actions"><button className="primary-button" disabled={busy} type="submit">{busy?'保存中…':'保存并启用'}</button><button className="secondary-button" disabled={busy} type="button" onClick={()=>setEditor(false)}>取消</button></div>
        </form>}
        <details className="cap-import-section"><summary>从 GitHub 导入技能</summary><form className="cap-import" onSubmit={e=>{e.preventDefault();void install();}}><label>技能目录链接<input type="url" required value={url} placeholder="https://github.com/作者/仓库/tree/分支/技能目录" onChange={e=>{setUrl(e.target.value);setReview(null);}}/></label><button className="secondary-button" disabled={busy||!url.trim()} type="submit">检查并导入</button></form></details>
        {review&&<div className="cap-editor"><p>该技能需要你确认后导入。来源：{review.url}</p><p>声明的能力：{review.permissions.join('、')||'请检查来源与技能内容'}</p><div className="cap-actions"><button className="secondary-button" disabled={busy} type="button" onClick={()=>void install(true)}>确认导入</button><button className="secondary-button" disabled={busy} type="button" onClick={()=>setReview(null)}>取消</button></div></div>}
        {!skills.length&&<p className="cap-empty">暂无技能。新建技能或从 GitHub 导入。</p>}
        <ul className="cap-list">{skills.map(skill=><li key={skill.id}><div><h3>{skill.name}</h3><p>{skill.description}</p><small>版本 {skill.version} · {skill.enabled?'已启用':'已停用'}</small></div><div className="cap-actions"><button className="secondary-button" type="button" onClick={()=>{setTestSkill(skill.id);setTab('test');}}>检查与运行</button>{skill.sourceType!=='bundled'&&<button className="secondary-button" type="button" disabled={busy} onClick={()=>setVersionSkill(versionSkill===skill.id?null:skill.id)}>历史版本</button>}<button className="secondary-button" type="button" disabled={busy} onClick={()=>void action(async()=>{const {content}=await api.get<{content:string}>(`/skills/${encodeURIComponent(skill.id)}/content`);setDraft({name:skill.sourceType==='bundled'?skill.name+'-自定义':skill.name,description:skill.description,instructions:content.replace(/^---[\s\S]*?---\s*/,'')});setEditing(skill.sourceType!=='bundled');setEditor(true);},'')}>{skill.sourceType==='bundled'?'创建自定义副本':'编辑'}</button><button className="secondary-button" type="button" disabled={busy} aria-pressed={skill.enabled} onClick={()=>void action(()=>api.patch(`/skills/${encodeURIComponent(skill.id)}/enabled`,{enabled:!skill.enabled}),skill.enabled?'技能已停用':'技能已启用')}>{skill.enabled?'停用':'启用'}</button></div></li>)}</ul>
      </div>}
      {tab==='skills'&&versionSkill&&<SkillVersions key={versionSkill} id={versionSkill} onChange={refresh}/>}
      {tab==='tools'&&<div><HttpTools onChange={refresh}/><div className="cap-toolbar"><div><h3>可用工具 <span className="cap-meta">{tools.length}</span></h3><p>控制小E可以调用哪些工具，以及何时需要确认。</p></div><label className="cap-search">搜索工具<input type="search" value={toolSearch} placeholder="输入名称或用途" onChange={e=>setToolSearch(e.target.value)}/></label></div><details className="cap-help"><summary>默认执行规则</summary><p>读取自动执行；技能写入和 MCP 调用先确认。明确要求新建任务时直接创建。停用会阻止小E调用，不影响项目页面的手动操作。</p></details>{!tools.some(tool=>`${tool.description} ${tool.name}`.toLowerCase().includes(toolSearch.toLowerCase()))&&<p className="cap-empty">没有匹配的工具。</p>}<ul className="cap-list cap-tool-list">{tools.filter(tool=>`${tool.description} ${tool.name}`.toLowerCase().includes(toolSearch.toLowerCase())).map(tool=><li key={tool.name}><div><h3>{tool.description}</h3><small>{tool.mode==='read'?'读取资料':'修改数据'} · {tool.name}</small><details><summary>参数与必填项</summary><ToolParameters value={tool.parameters}/></details></div><div className="cap-tool-controls"><label className="cap-policy">执行策略<StyledSelect value={tool.policy} disabled={busy} onChange={e=>void action(()=>api.patch(`/skills/tools/${encodeURIComponent(tool.name)}/policy`,{policy:e.target.value}),'执行策略已保存')}><option value="default">默认策略</option><option value="auto">自动执行</option><option value="confirm">每次确认</option></StyledSelect></label><button className="secondary-button" type="button" disabled={busy} aria-pressed={tool.enabled} onClick={()=>void action(()=>api.patch(`/skills/tools/${encodeURIComponent(tool.name)}/enabled`,{enabled:!tool.enabled}),tool.enabled?'工具已停用':'工具已启用')}>{tool.enabled?'停用':'启用'}</button></div></li>)}</ul></div>}
      {tab==='runs'&&<div><div className="cap-toolbar"><div><h3>最近执行</h3><p>最近 100 次调用的结果与耗时。</p></div></div>{!runs.length?<p className="cap-empty">暂无执行记录。工具调用后会显示在这里。</p>:<ul className="cap-list">{runs.map(run=><li key={run.id}><div><h3>{tools.find(t=>t.name===run.toolName)?.description??run.toolName}</h3><p>{({succeeded:'执行成功',failed:'执行失败',blocked:'已拦截'} as Record<string,string>)[run.status]??run.status} · {run.elapsedMs} 毫秒 · {new Date(run.createdAt).toLocaleString('zh-CN')}</p>{run.error&&<p className="cap-error">{run.error}</p>}</div></li>)}</ul>}</div>}
    </>}
  </section>;
}
