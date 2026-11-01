import {FeedbackBanner} from '../../components/FeedbackBanner';
import {useEffect,useRef,useState} from 'react';
import {ArrowRight,CheckCircle2,CircleHelp,Download,FilePenLine,Github,Plus,Puzzle,Search,Wrench,X} from 'lucide-react';
import {api} from '../../api';
import {StyledSelect} from '../../components/ui';
import {HttpTools} from './HttpTools';
import {McpConnections,SkillVersions} from './HarnessExtensions';
import {CapabilityDialog} from './CapabilityDialog';
import {defaultPolicyLabel,toolTitle} from './presentation';
import {useWorkbenchActive,useWorkbenchDraftValue} from '../conversations/useWorkbenchTabs';
import './capabilities.css';

type Health={status:string;enabled:boolean;version:string;checkedAt:string;stale?:boolean;analysisStatus:string;dependencies:Array<{name:string;available:boolean;enabled:boolean}>;missingCapabilities:string[];notice:string};
type Skill={id:string;name:string;description:string;enabled:boolean;sourceType:string;status:string;version:string;health?:Health|null};
type Tool={name:string;displayName?:string;description:string;mode:string;enabled:boolean;policy:string;parameters:string};
type Saved=Skill&{installed:boolean;permissions?:string[];healthError?:string};
const emptyDraft={name:'',description:'',instructions:''};
const healthLabel=(health?:Health|null)=>!health?'尚未检查':health.stale?'配置已变化':health.status==='blocked'?'依赖不可用':health.status==='dependencies_available'?'依赖可用':'待补充检查';

export function CapabilityCenter({hideHeading=false}:{hideHeading?:boolean}) {
  const panel=useRef<HTMLElement>(null),visible=useWorkbenchActive();
  const healthRef=useRef<HTMLDivElement>(null),healthTrigger=useRef<HTMLButtonElement|null>(null);
  const formPanels=useRef<HTMLDivElement>(null),searchRef=useRef<HTMLInputElement>(null);
  const [tab,setTab]=useState<'skills'|'tools'|'mcp'>('skills');
  const [skills,setSkills]=useState<Skill[]>([]),[tools,setTools]=useState<Tool[]>([]);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [mode,setMode]=useState<'create'|'github'|'edit'|null>(null),[draft,setDraft]=useState(emptyDraft),[url,setUrl]=useState('');
  const [review,setReview]=useState<{url:string;permissions:string[]}|null>(null);
  const [detailsId,setDetailsId]=useState<string|null>(null),[versionId,setVersionId]=useState<string|null>(null),[toolSearch,setToolSearch]=useState('');
  useEffect(()=>{
    if(!visible||!detailsId)return;
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!healthRef.current?.contains(event.target)&&!healthTrigger.current?.contains(event.target))setDetailsId(null);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented){setDetailsId(null);healthTrigger.current?.focus({preventScroll:true});}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[detailsId,visible]);
  useEffect(()=>{
    if(mode)formPanels.current?.querySelector<HTMLInputElement>('[data-skill-method="'+(mode==='github'?'github':'create')+'"] input')?.focus({preventScroll:true});
  },[mode]);
  useWorkbenchDraftValue('skill-editor',draft,mode==='create'||mode==='edit',busy);
  useWorkbenchDraftValue('skill-import',{url},mode==='github',busy);
  async function refresh(){const [s,t]=await Promise.all([api.get<Skill[]>('/skills'),api.get<Tool[]>('/skills/tools')]);setSkills(s.filter(skill=>skill.status==='installed'));setTools(t);}
  useEffect(()=>{if(!visible)return;let active=true;Promise.all([api.get<Skill[]>('/skills'),api.get<Tool[]>('/skills/tools')]).then(([s,t])=>{if(active){setSkills(s.filter(skill=>skill.status==='installed'));setTools(t);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[visible]);
  async function action(work:()=>Promise<unknown>,message=''){setBusy(true);setError('');setNotice('');try{await work();await refresh();if(message)setNotice(message);}catch(e){setError(e instanceof Error?e.message:'操作未完成，请重试。');}finally{setBusy(false);}}
  function close(){if(busy)return;setMode(null);setError('');setReview(null);}
  function added(saved:Saved){setMode(null);setReview(null);setUrl('');setDetailsId(saved.id);setNotice(saved.healthError||`技能已保存并启用，自动检查：${healthLabel(saved.health)}。`);}
  async function install(){await action(async()=>{const target=review?.url??url.trim();const result=await api.post<Saved>('/skills/install',{url:target,allowRisky:Boolean(review)});if(!result.installed){setReview({url:target,permissions:result.permissions??[]});return;}added(result);});}
  const matches=tools.filter(tool=>`${toolTitle(tool)} ${tool.description} ${tool.name}`.toLowerCase().includes(toolSearch.toLowerCase()));
  return <section ref={panel} className="settings-form subpage-panel capability-center">
    {!hideHeading?<div className="settings-heading"><div><h2>能力中心</h2><p>管理技能、工具与外部服务。</p></div></div>:null}
    <nav className="subpage-nav" aria-label="能力中心分类">{([['skills','技能'],['tools','工具'],['mcp','MCP 连接']] as const).map(([id,label])=><button key={id} type="button" aria-current={tab===id?'page':undefined} className={tab===id?'active':''} onClick={()=>{setTab(id);setNotice('');setError('');panel.current?.scrollTo({top:0});}}>{label}</button>)}</nav>
    {error&&!mode?<FeedbackBanner tone="error">{error} <button className="secondary-button" type="button" disabled={busy} onClick={()=>void action(async()=>{},'已重新加载')}>重新加载</button></FeedbackBanner>:null}
    {notice?<FeedbackBanner tone="success">{notice}</FeedbackBanner>:null}
    {loading?<p role="status">正在加载能力配置…</p>:tab==='mcp'?<McpConnections tools={tools} onChange={refresh}/>:tab==='skills'?<>
      <div className="cap-toolbar"><div><h3>已安装技能 <span className="cap-meta">{skills.length}</span></h3><p>告诉希微如何完成一类工作。</p></div><button className="primary-button" type="button" disabled={busy} onClick={()=>{setMode('create');setDraft(emptyDraft);setError('');setReview(null);}}><Plus size={13}/>新增技能</button></div>
      {!skills.length?<p className="cap-empty">还没有技能。点击“新增技能”，自己编写或从 GitHub 导入。</p>:null}
      <ul className="cap-list cap-skill-list">{skills.map(skill=><li key={skill.id}>
        <span className="cap-skill-icon" aria-hidden="true"><Puzzle size={18}/></span>
        <div className="cap-skill-copy"><h3>{skill.name}</h3><p>{skill.description}</p><small className="cap-skill-meta"><span>版本 {skill.version}</span><span data-enabled={skill.enabled}>{skill.enabled?'已启用':'已停用'}</span>{skill.health?<span>上次检查：{healthLabel(skill.health)}</span>:null}</small></div>
        <div className="cap-actions"><button className="secondary-button" type="button" disabled={busy} aria-expanded={detailsId===skill.id} aria-controls={detailsId===skill.id?`skill-health-${skill.id}`:undefined} onClick={event=>{healthTrigger.current=event.currentTarget;if(detailsId===skill.id)setDetailsId(null);else{setDetailsId(skill.id);if(!skill.health)void action(()=>api.post(`/skills/${encodeURIComponent(skill.id)}/check`));}}}>查看检查</button>{skill.sourceType!=='bundled'?<button className="secondary-button" type="button" disabled={busy} onClick={()=>setVersionId(skill.id)}>历史版本</button>:null}<button className="secondary-button" type="button" disabled={busy} onClick={()=>void action(async()=>{const {content}=await api.get<{content:string}>(`/skills/${encodeURIComponent(skill.id)}/content`);setDraft({name:skill.sourceType==='bundled'?skill.name+'-自定义':skill.name,description:skill.description,instructions:content.replace(/^---[\s\S]*?---\s*/,'')});setMode(skill.sourceType==='bundled'?'create':'edit');})}>{skill.sourceType==='bundled'?'创建副本':'编辑'}</button><button className="secondary-button" type="button" disabled={busy} aria-pressed={skill.enabled} onClick={()=>void action(()=>api.patch(`/skills/${encodeURIComponent(skill.id)}/enabled`,{enabled:!skill.enabled}),skill.enabled?'技能已停用':'技能已启用')}>{skill.enabled?'停用':'启用'}</button></div>
        {detailsId===skill.id?<div ref={healthRef} id={`skill-health-${skill.id}`} className="cap-skill-health" role="status"><header>{skill.health?.status==='dependencies_available'&&!skill.health.stale?<CheckCircle2 size={15}/>:<CircleHelp size={15}/>}<strong>{busy?'正在检查…':healthLabel(skill.health)}</strong><button type="button" className="text-button" disabled={busy} onClick={()=>void action(()=>api.post(`/skills/${encodeURIComponent(skill.id)}/check`),'检查结果已更新')}>重新检查</button></header>
          {skill.health?<><p>{skill.health.stale?'工具或技能配置已变化，请重新检查。':skill.health.analysisStatus==='not_run'?'规则与已声明依赖已检查；配置对话模型后，可补充分析执行规则。':skill.health.analysisStatus==='failed'?'规则与已声明依赖已检查；模型未返回有效分析，暂不能确认全部依赖。':'规则与工具依赖检查完成。实际任务请直接在聊天中发给希微。'}</p>{skill.health.dependencies.some(item=>!item.available||!item.enabled)||skill.health.missingCapabilities.length?<ul>{skill.health.dependencies.filter(item=>!item.available||!item.enabled).map(item=><li key={item.name}>{toolTitle(tools.find(tool=>tool.name===item.name)??{name:item.name,description:''})}：{item.available?'已停用':'未找到'}</li>)}{skill.health.missingCapabilities.map((item,index)=><li key={index}>{item}</li>)}</ul>:null}<small>检查不执行工具；实际运行结果以聊天中的执行过程为准。</small></>:<p>正在读取检查结果，稍后可重试。</p>}
        </div>:null}
      </li>)}</ul>
    </>:<>
      <HttpTools onChange={refresh}/>
      <div className="cap-toolbar cap-catalog-heading"><div><h3>可用工具 <span className="cap-meta">{tools.length}</span></h3><p>希微根据你的请求选择工具。停用后不再调用。</p></div><label className="cap-search"><Search size={13}/><span className="sr-only">搜索工具</span><input ref={searchRef} type="search" value={toolSearch} placeholder="搜索工具" autoComplete="off" onChange={e=>setToolSearch(e.target.value)}/>{toolSearch?<button className="cap-search-clear" type="button" aria-label="清除工具搜索" onClick={()=>{setToolSearch('');searchRef.current?.focus();}}><X size={12}/></button>:null}</label></div>
      {!matches.length?<p className="cap-empty">没有匹配的工具。</p>:null}
      <ul className="cap-list cap-tool-list">{matches.map(tool=><li key={tool.name}><span className="cap-tool-icon" aria-hidden="true"><Wrench size={16}/></span><div className="cap-tool-copy"><h3>{toolTitle(tool)}{!tool.enabled?<span className="cap-disabled-label">已停用</span>:null}</h3><p>{tool.description}</p></div><div className="cap-tool-controls"><label className="cap-policy"><span className="sr-only">{toolTitle(tool)}的执行方式</span><StyledSelect aria-label={`${toolTitle(tool)}的执行方式`} value={tool.policy} disabled={busy} onChange={e=>void action(()=>api.patch(`/skills/tools/${encodeURIComponent(tool.name)}/policy`,{policy:e.target.value}),'执行方式已保存')}><option value="default">{defaultPolicyLabel(tool)}</option><option value="auto">自动执行</option><option value="confirm">每次确认</option></StyledSelect></label><button className="secondary-button" type="button" disabled={busy} aria-pressed={tool.enabled} onClick={()=>void action(()=>api.patch(`/skills/tools/${encodeURIComponent(tool.name)}/enabled`,{enabled:!tool.enabled}),tool.enabled?'工具已停用':'工具已启用')}>{tool.enabled?'停用':'启用'}</button></div></li>)}</ul>
    </>}
    {mode?<CapabilityDialog title={mode==='edit'?'编辑技能':'新增技能'} className="cap-skill-dialog" busy={busy} onClose={close}>
      {mode!=='edit'?<div className="cap-dialog-methods" role="group" aria-label="添加技能的方式"><button type="button" aria-pressed={mode==='create'} disabled={busy} onClick={()=>{setMode('create');setError('');}}><FilePenLine size={15}/>自己编写</button><button type="button" aria-pressed={mode==='github'} disabled={busy} onClick={()=>{setMode('github');setError('');}}><Github size={15}/>从 GitHub 导入</button></div>:null}
      <div ref={formPanels} className="cap-skill-viewport">
        <div className="cap-skill-track" data-method={mode==='github'?'github':'create'}>
          <div className="cap-skill-panel" data-skill-method="create" aria-hidden={mode==='github'} inert={mode==='github'}>
            <form className="cap-dialog-form" onSubmit={e=>{e.preventDefault();void action(async()=>added(await api.post<Saved>('/skills/build',{...draft,generate:false,replace:mode==='edit'})));}}>
        <label>技能名称<input required autoFocus maxLength={64} readOnly={mode==='edit'} value={draft.name} placeholder="例如：会议行动项整理" onChange={e=>setDraft({...draft,name:e.target.value})}/></label><label>什么时候使用<input required maxLength={500} value={draft.description} placeholder="例如：会议结束后，提取结论并整理待办" onChange={e=>setDraft({...draft,description:e.target.value})}/><small>描述场景，帮助希微在合适的时候选用这项技能。</small></label><div className="cap-rule-heading"><label htmlFor="skill-rules">执行规则</label><button className="text-button" type="button" disabled={busy||!draft.name.trim()||!draft.description.trim()} onClick={()=>void action(async()=>{const value=await api.post<{content:string}>('/skills/draft',draft);setDraft(current=>({...current,instructions:value.content.replace(/^---[\s\S]*?---\s*/,'')}));})}>根据描述生成草稿<ArrowRight size={12}/></button></div><textarea id="skill-rules" required rows={7} maxLength={12000} value={draft.instructions} placeholder="希望希微按什么顺序处理，输出什么结果，需要遵守哪些规则…" onChange={e=>setDraft({...draft,instructions:e.target.value})}/>{error?<FeedbackBanner tone="error">{error}</FeedbackBanner>:null}<footer><button className="secondary-button" type="button" disabled={busy} onClick={close}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy?'正在保存并检查…':'保存并启用'}</button></footer>
      </form>
          </div>
          <div className="cap-skill-panel" data-skill-method="github" aria-hidden={mode!=='github'} inert={mode!=='github'}>
            <form className="cap-dialog-form" onSubmit={e=>{e.preventDefault();void install();}}><label>技能目录链接<input required type="url" autoFocus disabled={busy} value={url} placeholder="https://github.com/作者/仓库/tree/分支/技能目录" onChange={e=>{setUrl(e.target.value);setReview(null);setError('');}}/><small>复制包含 SKILL.md 文件的 GitHub 目录链接。</small></label>{review?<div className="skill-import-review"><p>该技能声明了需要确认的能力：</p><p>{review.permissions.join('、')||'请先核对技能来源和内容'}</p></div>:null}{error?<FeedbackBanner tone="error">{error}</FeedbackBanner>:null}<footer><button className="secondary-button" type="button" disabled={busy} onClick={close}>取消</button><button className="primary-button" type="submit" disabled={busy||!url.trim()}><Download size={13}/>{busy?'正在导入并检查…':review?'确认导入':'导入并检查'}</button></footer></form>
          </div>
        </div>
      </div>
    </CapabilityDialog>:null}
    {versionId?<CapabilityDialog title="技能历史版本" onClose={()=>setVersionId(null)}><SkillVersions id={versionId} onChange={refresh}/></CapabilityDialog>:null}
  </section>;
}
