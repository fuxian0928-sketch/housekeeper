import {FeedbackBanner} from '../../components/FeedbackBanner';
import {useState} from 'react';
import {RunProcess} from '../agent/RunProcess';
import {RunInspector} from '../agent/RunInspector';
import {useAgentRun} from '../agent/useAgentRun';
import type {DocumentEvidence} from './workbench-tabs';

type Props={runId:string;state?:ReturnType<typeof useAgentRun>;disabled?:boolean;onContinue:(id:string,message?:string)=>Promise<void>;onOpenDocument:(id:string,version?:number,evidence?:DocumentEvidence)=>void;onBusinessChanged:()=>Promise<void>};
function Content({state,...props}:Props&{state:ReturnType<typeof useAgentRun>}) {
  if(state.error)return <FeedbackBanner tone="error">{state.error}</FeedbackBanner>;
  if(!state.view)return <p role="status" className="muted">正在读取执行过程…</p>;
  const review=state.view.invocations.some(call=>['waiting_approval','unknown'].includes(call.status))||state.view.run.status==='reconciling';
  return <><RunProcess view={state.view}/>{review?<RunInspector reviewOnly runId={props.runId} runState={state} disabled={props.disabled} onContinue={props.onContinue} onOpenDocument={props.onOpenDocument} onBusinessChanged={props.onBusinessChanged}/>:null}</>;
}
function Saved(props:Props){const state=useAgentRun(props.runId);return <Content {...props} state={state}/>;}
export function MessageExecution(props:Props){const [open,setOpen]=useState(false);if(props.state?.view)return <Content {...props} state={props.state}/>;return <details className="chat-execution-details" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>执行过程</summary>{open?<Saved {...props}/>:null}</details>;}
