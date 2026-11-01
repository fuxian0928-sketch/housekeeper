// PCM16 mono 16kHz. Accumulate a small initial reservoir, not an entire answer.
// The deadline starts at the first PCM packet, so model thinking has no timer here.
async function* bufferPcmStart(source,{signal,targetMs=600,maxWaitMs=700,onReady}={}){
 const stats=()=>({bufferedMs:bufferedBytes/32,waitMs:firstAt===undefined?0:performance.now()-firstAt,firstChunkMs:firstBytes/32});
 const readBudget=(value,max)=>{const result=typeof value==='function'?value(stats()):value;if(!Number.isFinite(result)||result<0||result>max)throw Error('TTS_INVALID_START_BUFFER');return result;};
 if(!signal||!source?.[Symbol.asyncIterator])throw Error('TTS_INVALID_START_BUFFER');
 signal.throwIfAborted();
 const iterator=source[Symbol.asyncIterator](),queue=[];
 let pending,ended=false,firstAt,bufferedBytes=0,firstBytes=0,rejectAbort;
 readBudget(targetMs,2400);readBudget(maxWaitMs,3200);
 const cancelled=new Promise((_,reject)=>{rejectAbort=reject;});void cancelled.catch(()=>{});
 const abort=()=>rejectAbort(signal.reason??Error('TTS_CANCELLED'));
 signal.addEventListener('abort',abort,{once:true});
 const pull=()=>{
  if(!pending){pending=Promise.resolve().then(()=>iterator.next());void pending.catch(()=>{});}
  return pending;
 };
 const take=async timeoutMs=>{
  let timer;
  try{
   const item=await Promise.race([pull(),cancelled,...(timeoutMs===undefined?[]:[new Promise(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(0,timeoutMs));})])]);
   signal.throwIfAborted();
   if(item===null)return null; // Keep the outstanding read for the next pull.
   pending=undefined;
   if(item.done){ended=true;return item;}
   if(!Buffer.isBuffer(item.value)||!item.value.length||item.value.length>6400||item.value.length%2)throw Error('TTS_INVALID_START_PCM');
   return item;
  }finally{clearTimeout(timer);}
 };
 try{
  while(bufferedBytes<readBudget(targetMs,2400)*32){
   const remaining=firstAt===undefined?undefined:readBudget(maxWaitMs,3200)-(performance.now()-firstAt);
   if(remaining!==undefined&&remaining<=0)break;
   const item=await take(remaining);
   if(item===null){
    if(firstAt!==undefined&&readBudget(maxWaitMs,3200)>performance.now()-firstAt)continue;
    break;
   }
   if(item.done)break;
   if(firstAt===undefined){firstAt=performance.now();firstBytes=item.value.length;}
   const owned=Buffer.from(item.value);queue.push(owned);bufferedBytes+=owned.length;
  }
  try{onReady?.({bufferedMs:bufferedBytes/32,waitMs:firstAt===undefined?0:performance.now()-firstAt,sourceEnded:ended});}catch{}
  while(queue.length){signal.throwIfAborted();yield queue.shift();}
  while(!ended){const item=await take();if(item.done)break;yield item.value;}
 }finally{
  signal.removeEventListener('abort',abort);
  for(const pcm of queue)pcm.fill(0);queue.length=0;
  // A producer read may still be pending after the startup deadline. Do not
  // wait for it on cancellation or issue a second concurrent iterator.next().
  try{void Promise.resolve(iterator.return?.()).catch(()=>{});}catch{}
 }
}
function localSpeechStartPolicy(characters,stats){
 const lengthTarget=Math.min(2400,Math.max(600,Math.ceil((characters*25+200)/100)*100));
 let targetMs=lengthTarget;
 // Observe at least 800ms beyond the first packet before trusting production
 // speed. Fast long answers need not always wait for the largest reservoir.
 const observed=stats?stats.bufferedMs-stats.firstChunkMs:0;
 if(observed>=800&&stats.waitMs>=0){
  const rtf=stats.waitMs/observed;
  const rateTarget=rtf<=.8?600:rtf<=.95?1000:rtf<=1.05?1600:2400;
  targetMs=Math.min(lengthTarget,rateTarget);
 }
 return {targetMs,maxWaitMs:lengthTarget===600?700:Math.ceil(lengthTarget*1.3)};
}
module.exports={bufferPcmStart,localSpeechStartPolicy};
