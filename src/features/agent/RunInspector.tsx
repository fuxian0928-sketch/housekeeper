import type {DocumentEvidence} from '../conversations/workbench-tabs';
import {useEffect,useId,useRef,useState} from 'react';
import {AlertTriangle,Check,Copy,Download,FileText,FolderOpen,History,LoaderCircle,Pause,Play,RefreshCw,Square,Table2} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {api} from '../../api';
import {FeedbackBanner} from '../../components/FeedbackBanner';
import type {useAgentRun} from './useAgentRun';
import {RunProcess} from './RunProcess';
import {RunSources} from './RunSources';
import {runStatusLabel,type RunArtifact,type RunInvocation} from './types';

const plugins=[remarkGfm];
const toolNames:Record<string,string>={create_document:'保存文档',update_document:'更新文档',patch_document:'修改文档',create_task:'创建待办',update_task:'修改待办',create_project:'创建项目',update_project:'修改项目',export_spreadsheet:'导出表格',link_document_to_project:'关联项目资料',link_document_to_task:'关联任务资料',patch_office_file:'修改 Office 文件'};
const fields:Record<string,string>={title:'名称',content:'正文',description:'说明',dueAt:'截止日期',priority:'优先级',status:'状态',before:'原内容',after:'修改后',name:'名称',summary:'摘要',blockedReason:'等待原因',nextAction:'下一步'};
const text=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value,null,2);
function Markdown({content}:{content:string}){return <div className="markdown-body"><ReactMarkdown remarkPlugins={plugins} components={{a:({children,...props})=><a {...props} target="_blank" rel="noreferrer">{children}</a>}}>{content}</ReactMarkdown></div>;}
function Artifact({artifact,onOpenDocument}:{artifact:RunArtifact;onOpenDocument:(id:string,version?:number)=>void}){
  const [notice,setNotice]=useState('');
  useEffect(()=>{if(notice!=='已复制')return;const timer=window.setTimeout(()=>setNotice(''),1800);return()=>window.clearTimeout(timer);},[notice]);
  let data:{columns?:Array<{key:string;label:string}>;rows?:unknown[][];skippedNumericCells?:number}={};if(artifact.kind==='table')try{data=JSON.parse(artifact.content);}catch{/* Keep the saved raw artifact accessible below. */}
  async function copy(){try{await navigator.clipboard.writeText(artifact.content);setNotice('已复制');}catch{setNotice('复制失败，可直接选中正文复制。');}}
  const sourceCount=artifact.sources.filter(source=>source.documentId).length;
  return <article className="run-artifact"><header>{artifact.kind==='table'||artifact.kind==='spreadsheet'?<Table2 size={16}/>:<FileText size={16}/>}<div><h3>{artifact.title}</h3><small>{artifact.documentId?'已保存到资料库':artifact.kind==='spreadsheet'?'已生成文件':artifact.kind==='table'?'程序计算结果':'草稿 · 尚未保存到资料库'}{sourceCount?` · ${sourceCount} 项来源`:''}</small></div></header>
    {artifact.kind==='table'&&data.columns&&data.rows?<><div className="artifact-table-scroll" tabIndex={0} aria-label={`${artifact.title}表格`}><table><thead><tr>{data.columns.map(column=><th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{data.rows.map((row,index)=><tr key={index}>{row.map((value,column)=><td key={column}>{value==null?'—':String(value)}</td>)}</tr>)}</tbody></table></div>{data.skippedNumericCells?<p className="artifact-warning">{data.skippedNumericCells} 个非数值单元格未计入，请核对来源表格。</p>:null}</>:artifact.kind!=='spreadsheet'?<Markdown content={artifact.content}/>:<p>文件已保存。下载后可以继续在 Excel 中整理。</p>}
    <footer>{artifact.fileId?<a className="secondary-button" href={`/api/agent/files/${encodeURIComponent(artifact.fileId)}`} download><Download size={14}/>下载文件</a>:<button className="text-button artifact-copy" type="button" onClick={()=>void copy()}>{notice==='已复制'?<Check size={13}/>:<Copy size={13}/>}<span>{notice==='已复制'?'已复制':'复制内容'}</span></button>}{artifact.documentId?<button type="button" className="text-button" onClick={()=>onOpenDocument(artifact.documentId!)}><FolderOpen size={14}/>打开资料</button>:null}{notice?<span role="status" className={notice==='已复制'?'sr-only':undefined}>{notice}</span>:null}</footer>
  </article>;
}
export function RunInspector({runId,runState,onContinue,onOpenDocument,onBusinessChanged,onContents,disabled=false,reviewOnly=false}:{runId:string|null;runState:ReturnType<typeof useAgentRun>;onContinue:(id:string,message?:string)=>Promise<void>;onOpenDocument:(id:string,version?:number,evidence?:DocumentEvidence)=>void;onBusinessChanged:()=>Promise<void>;disabled?:boolean;onContents?:(available:boolean)=>void;reviewOnly?:boolean}){
  const {view,error,refresh}=runState,[tab,setTab]=useState<'artifacts'|'sources'|'changes'>(reviewOnly?'changes':'artifacts'),[busy,setBusy]=useState(false),[actionError,setActionError]=useState(''),[input,setInput]=useState(''),[evidence,setEvidence]=useState<Record<string,string>>({});
  const tabsId=useId(),previousAttention=useRef<string|null>(null);
  async function action(work:()=>Promise<unknown>){setBusy(true);setActionError('');try{await work();await onBusinessChanged();}catch(reason){setActionError(reason instanceof Error?reason.message:'操作没有完成，请检查后重试。');}finally{await refresh();setBusy(false);}}
  async function proposal(call:RunInvocation,confirm:boolean){await api.post(`/actions/${encodeURIComponent(call.proposalId!)}/${confirm?'confirm':'cancel'}`);await onContinue(runId!);}
  const waiting=view?.invocations.filter(call=>call.status==='waiting_approval')??[],unknown=view?.invocations.filter(call=>call.status==='unknown'||(call.status==='dispatching'&&view.run.status==='reconciling'))??[];
  const attention=waiting[0]?.id??unknown[0]?.id??null;
  useEffect(()=>{if(attention&&attention!==previousAttention.current)setTab('changes');previousAttention.current=attention;},[attention]);
  useEffect(()=>{onContents?.(Boolean(view?.artifacts.length));},[view?.artifacts.length]);
  const locked=busy||disabled;
  return <aside className={`run-inspector${reviewOnly?' chat-inline-review':''}`} aria-label={reviewOnly?'待核对操作':'事务成果与来源'}>
    <header className="inspector-heading"><div><h2>本次事务</h2><span className={`run-state state-${view?.run.status??'idle'}`}>{view?runStatusLabel[view.run.status]:'尚未开始'}</span></div>{runId?<button className="icon-button" type="button" onClick={()=>void refresh()} aria-label="刷新事务状态"><RefreshCw size={14}/></button>:<FileText size={16}/>}</header>
    {view?<section className="run-overview"><p title={view.run.goal}>{view.run.goal}</p><div className="run-controls">{view.run.status==='running'?<><button type="button" disabled={locked} onClick={()=>void action(()=>api.post(`/agent/runs/${runId}/control`,{action:'pause'}))}><Pause size={13}/>暂停</button>{view.run.executionMode==='foreground'?<button disabled={locked} type="button" onClick={()=>void action(()=>api.post(`/agent/runs/${runId}/control`,{action:'background'}))}>后台继续</button>:<small>后台处理中</small>}</>:['suspended','partial','failed'].includes(view.run.status)?<button type="button" disabled={locked} onClick={()=>void action(()=>onContinue(runId!))}><Play size={13}/>继续处理</button>:null}{!['completed','cancelled'].includes(view.run.status)?<button type="button" disabled={locked} onClick={()=>void action(()=>api.post(`/agent/runs/${runId}/control`,{action:'cancel'}))}><Square size={12}/>取消后续</button>:null}</div></section>:null}
    <nav className="inspector-tabs" role="tablist" aria-label="事务详情">{([['artifacts','成果',view?.artifacts.length??0],['sources','来源',view?.sources.length??0],['changes','修改',waiting.length+unknown.length]] as const).map(([id,label,count],index,items)=><button type="button" key={id} id={`${tabsId}-${id}`} role="tab" aria-selected={tab===id} aria-controls={`${tabsId}-panel`} tabIndex={tab===id?0:-1} className={tab===id?'active':''} onClick={()=>setTab(id)} onKeyDown={event=>{
      let next=index;
      if(event.key==='ArrowRight')next=(index+1)%items.length;
      else if(event.key==='ArrowLeft')next=(index-1+items.length)%items.length;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=items.length-1;
      else return;
      event.preventDefault();setTab(items[next][0]);event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>{label}{count?<span>{count}</span>:null}</button>)}</nav>
    <div className="inspector-content" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}`} key={tab} tabIndex={0}>
      {error||actionError?<FeedbackBanner tone="error" action={<button className="text-button" type="button" onClick={()=>void refresh()}>重试读取</button>}>{actionError||error}</FeedbackBanner>:null}
      {!runId?<div className="inspector-empty"><FileText size={24}/><h3>把想法变成一份成果</h3><p>交代一件事后，文档草稿、表格结果、引用资料和待确认修改会出现在这里。</p><ul><li>根据资料写一份周报</li><li>对比文档并修改指定段落</li><li>整理表格，再生成后续待办</li></ul></div>:!view&&!error?<div className="inspector-empty" role="status"><LoaderCircle size={20} className="spin"/><p>正在读取事务记录…</p></div>:null}
      {view?.run.status==='waiting_input'?<form className="run-input-form" onSubmit={event=>{event.preventDefault();void action(async()=>{await onContinue(runId!,input.trim());setInput('');});}}><label htmlFor="run-additional-input">{view.run.answer}</label><textarea id="run-additional-input" value={input} onChange={event=>setInput(event.target.value)} required maxLength={12000} placeholder="补充这项事务需要的信息"/><button className="primary-button" disabled={locked||!input.trim()}>补充并继续</button></form>:null}
      {waiting.length&&tab!=='changes'?<button className="run-attention" type="button" onClick={()=>setTab('changes')}><History size={14}/>{waiting.length} 项修改等待确认<Play size={13}/></button>:null}
      {unknown.length&&tab!=='changes'?<button className="run-attention warning" type="button" onClick={()=>setTab('changes')}><AlertTriangle size={14}/>有操作结果需要核实</button>:null}
      {tab==='artifacts'&&view?<RunProcess view={view}/>:null}
      {tab==='artifacts'?view?.artifacts.length?view.artifacts.map(artifact=><Artifact key={artifact.id} artifact={artifact} onOpenDocument={onOpenDocument}/>):view?<p className="inspector-note">{['running','queued'].includes(view.run.status)?'正在处理，成果准备好后会显示在这里。':'这项事务还没有生成文档或表格成果。'}</p>:null:null}
      {tab==='sources'?view?.sources.length?<RunSources sources={view.sources} onOpen={source=>onOpenDocument(source.documentId,source.version,source.parentId?{parentId:source.parentId,sourceRevision:source.sourceRevision}:undefined)}/>:view?<p className="inspector-note">尚未引用资料。直接交流不一定需要检索文档。</p>:null:null}
      {tab==='changes'?<>{waiting.map(call=><article className="run-approval" key={call.id}><h3>{toolNames[call.toolName]??'执行已连接的服务'}</h3><p>确认后执行这项修改，并继续处理本次事务。</p><dl>{Object.entries(call.arguments).filter(([key])=>fields[key]).map(([key,value])=><div key={key} data-change={key}><dt>{fields[key]}</dt><dd>{['content','before','after'].includes(key)?<Markdown content={text(value)}/>:text(value)||'未填写'}</dd></div>)}</dl><details><summary>查看完整参数</summary><pre>{JSON.stringify(call.arguments,null,2)}</pre></details><footer><button className="secondary-button" type="button" disabled={locked} onClick={()=>void action(()=>proposal(call,false))}>取消此修改</button><button className="primary-button" type="button" disabled={locked} onClick={()=>void action(()=>proposal(call,true))}>{busy?<LoaderCircle size={13} className="spin"/>:<Check size={13}/>}确认并继续</button></footer></article>)}{unknown.map(call=><article className="run-approval uncertain" key={call.id}><h3><AlertTriangle size={15}/>核实操作结果</h3><p>{call.error||'请求可能已经生效。先到目标位置核对，避免重复提交。'}</p><details><summary>查看原操作与回执</summary><pre>{JSON.stringify({operation:call.toolName,arguments:call.arguments,receipt:call.lateResult??call.result},null,2)}</pre></details><label>核对依据<textarea value={evidence[call.id]??''} maxLength={1000} onChange={event=>setEvidence(current=>({...current,[call.id]:event.target.value}))} placeholder="例如：已查看目标项目，未出现这条待办"/></label><footer>{(['succeeded','not_applied'] as const).map(outcome=><button key={outcome} type="button" className="secondary-button" disabled={locked||(evidence[call.id]?.trim().length??0)<3} onClick={()=>void action(()=>api.post(`/agent/runs/${runId}/reconcile`,{invocationId:call.id,outcome,evidence:evidence[call.id]}))}>{outcome==='succeeded'?'核实已生效':'核实未生效'}</button>)}</footer></article>)}{!waiting.length&&!unknown.length?<p className="inspector-note">当前没有待确认或待核实的修改。</p>:null}</>:null}
    </div>
  </aside>;
}
