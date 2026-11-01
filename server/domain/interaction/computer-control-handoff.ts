import {setTimeout as delay} from 'node:timers/promises';

type ControlState={state:'ready'|'ai'|'user'|'takeover_pending'|'unavailable';generation:number;wait_seconds:number};
export function computerControlBlocked(code='USER_CONTROL'){
  const message=code==='CONTROL_UNAVAILABLE'?'本机控制暂不可用，已停止后续操作。':code==='HANDOFF_TIMEOUT'?'键鼠仍在使用，已暂停这项事务；空闲后可以继续。':'你已接管电脑，已暂停后续操作。';
  return Object.assign(new Error(message),{statusCode:422,controlBlocked:true,controlCode:code});
}

// Only accept the fixed ControlStatus protocol, never infer ownership from prose.
export function readComputerControlState(result:unknown):ControlState{
  if(!result||typeof result!=='object')throw computerControlBlocked('CONTROL_UNAVAILABLE');
  const value=result as {isError?:boolean;structuredContent?:unknown;content?:Array<{type?:string;text?:string}>};
  if(value.isError)throw computerControlBlocked('CONTROL_UNAVAILABLE');
  const candidates=[value.structuredContent,...(Array.isArray(value.content)?value.content.filter(item=>item?.type==='text'&&typeof item.text==='string'&&item.text.length<=4000).map(item=>{try{return JSON.parse(item.text!);}catch{return null;}}):[])];
  for(const candidate of candidates){
    if(!candidate||typeof candidate!=='object')continue;
    const row=candidate as Record<string,unknown>;
    if(!['ready','ai','user','takeover_pending','unavailable'].includes(String(row.state))||!Number.isSafeInteger(row.generation)||Number(row.generation)<0||typeof row.wait_seconds!=='number'||!Number.isFinite(row.wait_seconds)||row.wait_seconds<0||row.wait_seconds>30)continue;
    return {state:row.state as ControlState['state'],generation:Number(row.generation),wait_seconds:row.wait_seconds};
  }
  throw computerControlBlocked('CONTROL_UNAVAILABLE');
}

export async function handoffComputerControl(input:{
  readStatus:()=>Promise<unknown>;initial:boolean;signal?:AbortSignal;onWaiting?:()=>void;onReady?:()=>void;
  now?:()=>number;sleep?:(ms:number,signal?:AbortSignal)=>Promise<void>;timeoutMs?:number;
}){
  const now=input.now??(()=>performance.now()),sleep=input.sleep??(async(ms,signal)=>{await delay(ms,undefined,{signal});});
  const deadline=now()+Math.min(15000,Math.max(0,input.timeoutMs??15000));
  let waiting=false;
  for(;;){
    input.signal?.throwIfAborted();
    const state=readComputerControlState(await input.readStatus());
    input.signal?.throwIfAborted();
    if(state.state==='ready'||state.state==='ai'){if(waiting)input.onReady?.();return;}
    // Wait only for the initial submission/confirmation handoff. Never reacquire
    // automatically after a takeover, a failed lease or an uncertain action.
    if(state.state!=='user'||!input.initial)throw computerControlBlocked(state.state==='unavailable'?'CONTROL_UNAVAILABLE':state.state==='takeover_pending'?'TAKEOVER_PENDING':'USER_CONTROL');
    if(now()>=deadline)throw computerControlBlocked('HANDOFF_TIMEOUT');
    if(!waiting){waiting=true;input.onWaiting?.();}
    await sleep(Math.min(500,Math.max(100,state.wait_seconds*1000),Math.max(1,deadline-now())),input.signal);
  }
}
