import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from '../../api';
import type {RunView} from './types';

export function useAgentRun(runId:string|null,active=false){
  const [view,setView]=useState<RunView|null>(null),[error,setError]=useState('');
  const cursor=useRef(0),generation=useRef(0),currentRun=useRef(runId);currentRun.current=runId;
  const refresh=useCallback(async()=>{
    if(!runId)return;
    const requestGeneration=generation.current;
    try{
      const next=await api.get<RunView>(`/agent/runs/${encodeURIComponent(runId)}?after=${cursor.current}`);
      if(currentRun.current!==runId||generation.current!==requestGeneration)return;
      cursor.current=Math.max(cursor.current,...next.events.map(event=>event.seq));
      setView(previous=>({...next,events:[...(previous?.run.id===runId?previous.events:[]),...next.events].filter((event,index,items)=>items.findIndex(item=>item.seq===event.seq)===index).slice(-800)}));setError('');
      return next;
    }catch(reason){if(currentRun.current===runId&&generation.current===requestGeneration)setError(reason instanceof Error?reason.message:'执行记录暂时无法读取，请重试。');}
  },[runId]);
  useEffect(()=>{
    generation.current++;cursor.current=0;setView(previous=>previous?.run.id===runId?previous:null);setError('');let disposed=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{const next=await refresh();if(disposed)return;if(!next||['queued','running','waiting_approval','reconciling'].includes(next.run.status))timer=setTimeout(()=>void poll(),next?1800:5000);};
    if(runId)void poll();return()=>{disposed=true;generation.current++;clearTimeout(timer);};
  },[runId,refresh,active]);
  return{view:view?.run.id===runId?view:null,error,refresh};
}
