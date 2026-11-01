const {setTimeout:delay}=require('node:timers/promises');

// Restore a connection in the background; never replay a user turn or operation.
// One owner, bounded retries, and no wake-up after manual off or application exit.
function createStartupRestore({enabled,start,delays=[0,2000,5000,15000,30000]}){
 let closed=false,pending=null,controller=null;
 return {
  restore(){
   if(pending)return pending;
   if(closed||!enabled())return Promise.resolve(false);
   const current=new AbortController();controller=current;
   pending=(async()=>{
    for(const ms of delays){
     if(closed||current.signal.aborted||!enabled())return false;
     try{
      if(ms)await delay(ms,undefined,{signal:current.signal});
      if(closed||current.signal.aborted||!enabled())return false;
      if(await start())return !closed&&!current.signal.aborted&&enabled();
     }catch{if(current.signal.aborted)return false;}
    }
    return false;
   })().finally(()=>{if(controller===current){controller=null;pending=null;}});
   return pending;
  },
  cancel(){controller?.abort();},
  close(){closed=true;controller?.abort();}
 };
}
module.exports={createStartupRestore};
