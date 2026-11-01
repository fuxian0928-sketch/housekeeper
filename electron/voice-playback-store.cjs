const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Only bounded delivery metadata is persisted, never answer text or PCM.
function clean(value, recovering = false) {
  if (!value || typeof value !== 'object') return null;
  const {conversationId, assistantMessageId, answerHash, state, answerSubmittedSamples, attribution} = value;
  if (![conversationId,assistantMessageId].every(x=>typeof x==='string'&&x.length>0&&x.length<=200)
    || typeof answerHash!=='string'||!/^[a-f0-9]{64}$/.test(answerHash)
    || !['pending','partial','submitted','interrupted','device-error','device-closed'].includes(state)
    || !Number.isSafeInteger(answerSubmittedSamples)||answerSubmittedSamples<0||answerSubmittedSamples>480000
    || !['known','unknown'].includes(attribution)) return null;
  const unfinished = recovering && ['pending','partial'].includes(state);
  return {conversationId,assistantMessageId,answerHash,state:unfinished?'interrupted':state,
    answerSubmittedSamples,attribution:unfinished?'unknown':attribution};
}
function createPlaybackStore(file) {
  let records=[], pending=false, timer=null, serial=null, failed=false;
  try {
    if(fs.statSync(file).size>131072) throw Error('SIZE');
    const data=JSON.parse(fs.readFileSync(file,'utf8'));
    if(data.version!==1||!Array.isArray(data.records)||data.records.length>64)throw Error('SCHEMA');
    records=data.records.map(r=>clean(r,true)).filter(Boolean);
  } catch {}
  function update(snapshot) {
    const before=JSON.stringify(records);
    for(const item of snapshot){
      const record=clean(item);if(!record)continue;
      records=records.filter(r=>!(r.conversationId===record.conversationId&&r.assistantMessageId===record.assistantMessageId));
      records.push(record);
    }
    records=records.slice(-64);if(JSON.stringify(records)===before&&!failed)return;pending=true;
    if(!timer){timer=setTimeout(()=>{timer=null;void flush();},250);timer.unref?.();}
  }
  function flush(){
    if(timer){clearTimeout(timer);timer=null;}
    if(serial)return serial;
    if(!pending)return Promise.resolve();
    serial=(async()=>{
      while(pending){
        pending=false;const payload=JSON.stringify({version:1,records});
        try {await fsp.mkdir(path.dirname(file),{recursive:true});await fsp.writeFile(file+'.tmp',payload,{mode:0o600});await fsp.rename(file+'.tmp',file);failed=false;}
        catch {failed=true;try{await fsp.unlink(file+'.tmp');}catch{}}
      }
    })().finally(()=>{serial=null;});return serial;
  }

  return {update,flush,context(id){const r=records.findLast(r=>r.conversationId===id);return r?{...r}:null;},status:()=>({failed})};
}
module.exports={createPlaybackStore};
