import {useId,useState} from 'react';
import {AlertTriangle,Check,ChevronDown,Minus,Pause,Square,X} from 'lucide-react';
import type {ProcessRow,ProcessStatus} from './process-rows';
import './process-rows.css';

const statusLabels:Record<ProcessStatus,string>={pending:'等待中',running:'处理中',done:'已完成',failed:'未完成',waiting:'待确认',paused:'已暂停',unknown:'待核实',cancelled:'已取消',recorded:'已记录'};

function StatusIcon({status,step}:{status:ProcessStatus;step:number}){
  if(status==='running'||status==='pending')return <span className="process-ring"><span className="process-ring-track" aria-hidden="true"/>{status==='running'?<span className="process-ring-sweep" aria-hidden="true"/>:null}<span>{step}</span></span>;
  const Icon=status==='done'?Check:status==='failed'?X:status==='waiting'||status==='paused'?Pause:status==='unknown'?AlertTriangle:status==='cancelled'?Square:Minus;
  return <span className="process-badge"><Icon size={status==='done'?13:12} strokeWidth={2.8} aria-hidden="true"/></span>;
}
function ProcessTask({row,index}:{row:ProcessRow;index:number}){
  const id=useId(),[manualOpen,setManualOpen]=useState<boolean|null>(null);
  const hasDetails=row.details.length>0;
  const open=hasDetails&&(manualOpen??['running','failed','waiting','unknown'].includes(row.status));
  return <li className="process-task" data-status={row.status} data-open={open} style={{'--row-delay':`${Math.min(index,5)*60}ms`} as React.CSSProperties}>
    <button type="button" className="process-task-trigger" aria-expanded={hasDetails?open:undefined} aria-controls={hasDetails?id:undefined} aria-label={`${row.label}，${statusLabels[row.status]}${hasDetails?open?'，收起详情':'，展开详情':''}`} disabled={!hasDetails} onClick={()=>setManualOpen(!open)}>
      <StatusIcon status={row.status} step={index+1}/>
      <span className="process-task-label" title={row.label}>{row.label}</span>
      {row.meta?<span className="process-task-meta">{row.meta}</span>:null}
      <span className="process-task-status">{statusLabels[row.status]}</span>
      {hasDetails?<ChevronDown className="process-task-chevron" size={15} aria-hidden="true"/>:<span className="process-task-chevron"/>}
    </button>
    {hasDetails?<div id={id} className="process-task-expansion" aria-hidden={!open}><div><ul className="process-task-details">{row.details.map((detail,index)=><li key={index}><span>{detail.label}</span>{detail.createdAt&&!Number.isNaN(Date.parse(detail.createdAt))?<time dateTime={detail.createdAt}>{new Date(detail.createdAt).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>:detail.meta?<small>{detail.meta}</small>:null}</li>)}</ul></div></div>:null}
  </li>;
}
export function ProcessRows({rows,label='执行过程'}:{rows:ProcessRow[];label?:string}){
  if(!rows.length)return null;
  const completed=rows.filter(row=>row.status==='done').length;
  const active=[...rows].reverse().find(row=>['running','waiting','unknown','failed'].includes(row.status));
  return <section className="process-rows" aria-label={label}>
    <header><h3>{label}</h3><span>{rows.length} 步{completed?` · ${completed} 项已完成`:''}</span></header>
    <span className="sr-only" role="status">{active?`${active.label}，${statusLabels[active.status]}`:'执行状态已更新'}</span>
    <ol>{rows.map((row,index)=><ProcessTask key={row.id} row={row} index={index}/>)}</ol>
  </section>;
}
