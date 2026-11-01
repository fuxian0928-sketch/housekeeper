let foreground = 0;
const background = new Set<AbortController>();
export const foregroundMemoryBusy = () => foreground > 0;
export function beginForegroundWork() {
  foreground++;
  for(const controller of background)controller.abort(Object.assign(new Error('后台记忆为当前对话让出资源。'),{code:'MEMORY_FOREGROUND_PREEMPTED'}));
  let closed=false;
  return()=>{if(!closed){closed=true;foreground=Math.max(0,foreground-1);}};
}
export function beginBackgroundMemory() {
  const controller=new AbortController();background.add(controller);
  if(foreground)controller.abort(Object.assign(new Error('当前对话优先。'),{code:'MEMORY_FOREGROUND_PREEMPTED'}));
  return{signal:controller.signal,finish:()=>background.delete(controller)};
}

/** A provider ignoring cancellation must not keep the durable queue locked. */
export async function awaitMemoryWork<T>(start:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();
  let abort=()=>{};
  try{
    return await new Promise<T>((resolve,reject)=>{
      abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(()=>{signal.throwIfAborted();return start(signal);}).then(resolve,reject);
    });
  }finally{signal.removeEventListener('abort',abort);}
}
