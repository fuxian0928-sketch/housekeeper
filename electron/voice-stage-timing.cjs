const fs=require('node:fs/promises'),path=require('node:path');
const allowed=new Set(['turn-start','turn-end','asr-final','tts-start','tts-ready','answer-start','first-answer-text','first-sentence','first-answer-pcm','playback-complete','response-failed','response-cancelled','turn-cancelled','asr-failed','turn-failed','turn-finished','tts-first-raw-pcm','tts-first-voiced-pcm','tts-buffer-ready','tts-production','device-first-frame','playback-health']);
const metricFields=new Set(['synthesisMs','creditWaitMs','audioMs','segments','trimmedMs','bufferedMs','bufferWaitMs','startupMs','pausedMs','underrunMs','underrunCount','queuedMs','deviceOutputUnderflows','deviceInputOverflows','deviceLateCallbacks','deviceMaxGapMs','headOutputUnderflows','headLateCallbacks','headMaxGapMs']);
const cancelReasons=new Set(['interrupted','dismissed','work-timeout','discontinuity','stopped','manual-wake','short-noise']);
function createVoiceStageTiming(file,now=()=>performance.now()){
 const rows=[];let dirty=false,writing=null,timer=null,failed=false;
 function mark(key,stage){
  if(!allowed.has(stage)||!['generation','audioGeneration','turn'].every(k=>Number.isSafeInteger(key?.[k])&&key[k]>0))return;
  let row=rows.find(r=>['generation','audioGeneration','turn'].every(k=>r[k]===key[k]));
  if(!row){if(stage!=='turn-start')return;row={generation:key.generation,audioGeneration:key.audioGeneration,turn:key.turn,startedAt:new Date().toISOString(),...(key.reason==='wake'||key.reason==='speech'||key.reason==='interruption'?{trigger:key.reason}:{}),origin:now(),marks:{}};rows.push(row);if(rows.length>64)rows.shift();}
  if(row.marks[stage]!==undefined)return;const elapsed=now()-row.origin;if(!Number.isFinite(elapsed)||elapsed<0)return;
  if(stage==='turn-cancelled'&&cancelReasons.has(key.reason))row.cancelReason=key.reason;
  if(stage==='turn-failed'&&typeof key.code==='string'&&/^(?:VOICE|ASR)_[A-Z_]{1,48}$/.test(key.code))row.failureCode=key.code;
  row.marks[stage]=Math.round(elapsed);dirty=true;
  if(!timer){timer=setTimeout(()=>{timer=null;void flush();},250);timer.unref?.();}
 }
 function record(key,stage,values){
  if(!allowed.has(stage))return;mark(key,stage);
  const row=rows.find(r=>['generation','audioGeneration','turn'].every(k=>r[k]===key?.[k]));if(!row)return;
  const clean=Object.fromEntries(Object.entries(values??{}).filter(([name,value])=>metricFields.has(name)&&Number.isFinite(value)&&value>=0&&value<=240000).map(([name,value])=>[name,Math.round(value)]));
  if(!Object.keys(clean).length)return;
  row.metrics={...row.metrics,...clean};dirty=true;
  if(!timer){timer=setTimeout(()=>{timer=null;void flush();},250);timer.unref?.();}
 }
 function snapshot(){return rows.map(({origin,...r})=>({...r,marks:{...r.marks},...(r.metrics?{metrics:{...r.metrics}}:{})}));}
 function flush(){
  if(timer){clearTimeout(timer);timer=null;}if(writing)return writing;if(!dirty)return Promise.resolve();
  writing=(async()=>{while(dirty){dirty=false;const content=JSON.stringify({version:1,clock:'monotonic elapsed milliseconds',audibility:'unverified',turns:snapshot()});try{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',content,{mode:0o600});await fs.rename(file+'.tmp',file);failed=false;}catch{failed=true;}}})().finally(()=>{writing=null;});return writing;
 }
 async function clear(){rows.length=0;dirty=true;await flush();if(failed)throw Error('语音耗时记录未能清除，请检查磁盘空间或文件占用后重试。');}
 return {mark,record,snapshot,flush,clear,status:()=>({failed})};
}
module.exports={createVoiceStageTiming};
