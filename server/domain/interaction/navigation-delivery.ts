import {randomUUID} from 'node:crypto';
import type {NavigationTarget} from './contextual-navigation.js';
type Pending={token:string;complete:(shown:boolean)=>void};
const pending=new Map<string,Pending>();
export type NavigationRequest={id:string;token:string;target:NavigationTarget;deviceId?:string};
export async function deliverNavigation(target:NavigationTarget,emit:(request:NavigationRequest)=>void,deviceId?:string,signal?:AbortSignal){
  signal?.throwIfAborted();const id=randomUUID(),token=randomUUID();
  let finish:(shown:boolean)=>void=()=>{};
  const completion=new Promise<boolean>(resolve=>{finish=resolve;pending.set(id,{token,complete:resolve});});
  const timer=setTimeout(()=>finish(false),2500),abort=()=>finish(false);signal?.addEventListener('abort',abort,{once:true});
  try{emit({id,token,target,deviceId});const shown=await completion;return {target,shown,requested:true,notice:shown?'当前设备已显示目标页面。':'已找到目标，但尚未收到页面显示回执；不能声称已打开。'};}
  finally{clearTimeout(timer);pending.delete(id);signal?.removeEventListener('abort',abort);}
}
export function acknowledgeNavigation(id:string,token:unknown,shown:unknown){const request=pending.get(id);if(!request||request.token!==token)throw Object.assign(new Error('页面请求已过期。'),{statusCode:409});request.complete(shown===true);return {recorded:true};}
