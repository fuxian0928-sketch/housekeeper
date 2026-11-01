import {FeedbackBanner} from '../../components/FeedbackBanner';
import {useEffect,useState} from 'react';
import {api} from '../../api';
import {ProcessRows} from '../agent/ProcessRows';
import type {ProcessRow,ProcessStatus} from '../agent/process-rows';
import {UncertainOperations} from '../capabilities/UncertainOperations';
import {toolTitle} from '../capabilities/presentation';

type Tool={name:string;description:string;displayName?:string};
type Call={id:string;toolName:string;status:string;elapsedMs:number;error:string|null;createdAt:string};
const statuses:Record<string,ProcessStatus>={succeeded:'done',failed:'failed',blocked:'failed',unknown:'unknown'};
export function ChatToolActivity({active}:{active:boolean}) {
  const [open,setOpen]=useState(false),[tools,setTools]=useState<Tool[]>([]),[calls,setCalls]=useState<Call[]>([]);
  const [loading,setLoading]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{if(!open||!active)return;let live=true;setLoading(true);setError('');Promise.all([api.get<Tool[]>('/skills/tools'),api.get<Call[]>('/skills/tool-runs')]).then(([t,r])=>{if(live){setTools(t);setCalls(r);}}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[open,active,revision]);
  const rows:ProcessRow[]=calls.map(call=>({id:call.id,label:toolTitle(tools.find(tool=>tool.name===call.toolName)??{name:call.toolName,description:''}),status:statuses[call.status]??'recorded',meta:`${call.elapsedMs}ms`,details:[{label:new Date(call.createdAt).toLocaleString('zh-CN')},...(call.error?[{label:call.error}]:[])]}));
  return <details className="chat-tool-activity" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>工具调用记录</summary>{open?<div className="chat-tool-activity-content"><p>最近 100 次实际调用，包含聊天和连接检查。</p>{loading?<p role="status">正在读取…</p>:error?<FeedbackBanner tone="error">{error} <button type="button" className="text-button" onClick={()=>setRevision(value=>value+1)}>重试</button></FeedbackBanner>:<><UncertainOperations tools={tools}/>{rows.length?<ProcessRows rows={rows} label="实际调用"/>:<p>还没有工具调用记录。</p>}</>}</div>:null}</details>;
}
