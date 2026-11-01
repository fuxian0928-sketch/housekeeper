const { setTimeout: delay } = require('node:timers/promises');
const {createPortraitPlaybackMeter} = require('./portrait-playback-meter.cjs');

function readGain(readVolume) {
  const value=readVolume();
  return Number.isFinite(value)?Math.max(0,Math.min(100,value))/100:1;
}
function scaleOwnedPcm(pcm,gain) {
  if(gain===1)return;
  for(let offset=0;offset<pcm.length;offset+=2)pcm.writeInt16LE(Math.round(pcm.readInt16LE(offset)*gain),offset);
}

// Trusted process only. PCM16 mono 16kHz, paced to keep native buffer bounded.
// A successful receipt proves device submission, not physical speaker audibility.
class NativePlayback {
  constructor(worker, { sourceTimeoutMs = 30000, playbackTimeoutMs = 35000, maxDurationMs = 240000, readVolume = () => 100, leadMs = 500, onLevel } = {}) {
    if (![sourceTimeoutMs,playbackTimeoutMs].every(n => Number.isFinite(n) && n > 0 && n <= 35000) || sourceTimeoutMs > playbackTimeoutMs || !Number.isFinite(maxDurationMs) || maxDurationMs < playbackTimeoutMs || maxDurationMs > 240000) throw Error('PLAYBACK_INVALID_BUDGET');
    if(typeof readVolume!=='function')throw Error('PLAYBACK_INVALID_VOLUME_READER');
    if(!Number.isFinite(leadMs)||leadMs<0||leadMs>1000)throw Error('PLAYBACK_INVALID_LEAD');
    this.readVolume=readVolume;
    this.worker = worker; this.active = null;
    this.sourceTimeoutMs = sourceTimeoutMs; this.playbackTimeoutMs = playbackTimeoutMs;
    this.maxDurationMs = maxDurationMs;
    this.leadMs=leadMs;
    this.onLevel=onLevel;
  }
  // Keep a bounded lead over device pace. The producer must bound its own network
  // queue and honor signal; this layer never collects a whole response first.
  pause(key, pauseId) { return this.controlPause(key, pauseId, 'playback-pause'); }
  resume(key, pauseId) { return this.controlPause(key, pauseId, 'playback-resume'); }
  controlPause(key, pauseId, type) {
    const run = this.active;
    if (!run || run.controller.signal.aborted || !['generation', 'audioGeneration', 'turn'].every(field => run.key[field] === key[field])) return false;
    return this.worker.playback({ ...key, type, pauseId });
  }
  async playStream(key, source, signal) {
    signal.throwIfAborted();
    if (![key.generation,key.audioGeneration,key.turn].every(n=>Number.isSafeInteger(n)&&n>0) || !source?.[Symbol.asyncIterator]) throw Error('PLAYBACK_INVALID_INPUT');
    if (this.active) throw Error('PLAYBACK_ALREADY_ACTIVE');
    const gain=readGain(this.readVolume);
    const controller=new AbortController(), combined=AbortSignal.any([signal,controller.signal]);
    const iterator=source[Symbol.asyncIterator]();
    const run={controller,key:{...key}};this.active=run;
    const meter=createPortraitPlaybackMeter(this.worker,key,this.onLevel);
    let submitted=false,frames=0,bytes=0,sequence=0,carry=Buffer.alloc(0),nextAt=0;
    let resolveReceipt,rejectReceipt,rejectAbort;
    let pauseId=0, paused=false, pauseGate, releasePause;
    const receipt=new Promise((resolve,reject)=>{resolveReceipt=resolve;rejectReceipt=reject;});
    const cancelled=new Promise((_,reject)=>{rejectAbort=reject;});
    void receipt.catch(()=>{});void cancelled.catch(()=>{});
    const send=(type,extra={})=>{if(!this.worker.playback({...key,type,...extra}))throw Error('PLAYBACK_SEND_FAILED');};
    const sendReady=async(type,extra={},accepted=()=>{})=>{
      if(this.worker.waitForPlaybackCapacity&&!await this.worker.waitForPlaybackCapacity(key,combined))throw Error('PLAYBACK_SEND_FAILED');
      combined.throwIfAborted();send(type,extra);accepted();
    };
    const fail=code=>{const error=Error(code);rejectReceipt(error);rejectAbort(error);controller.abort();};
    const abort=()=>fail('PLAYBACK_CANCELLED');
    const matches=e=>e.generation===key.generation&&e.audioGeneration===key.audioGeneration&&e.turn===key.turn;
    const event=e=>{
      if(e.generation!==key.generation)return;
      if(e.type==='turn-start'&&!matches(e)){fail('PLAYBACK_SUPERSEDED');return;}
      if(!matches(e))return;
      if(e.type==='playback-paused'||e.type==='playback-resumed'){
        if(!Number.isSafeInteger(e.pauseId)||e.pauseId<1||!Number.isSafeInteger(e.renderedFrames)||e.renderedFrames<0||e.renderedFrames>frames){fail('PLAYBACK_INVALID_PAUSE');return;}
        if(e.pauseId<pauseId)return;
        if(e.type==='playback-paused'){
          if(e.pauseId===pauseId)return;
          releasePause?.();pauseId=e.pauseId;paused=true;
          pauseGate=new Promise(resolve=>{releasePause=resolve;});
        }else{pauseId=e.pauseId;paused=false;nextAt=performance.now()+(frames-e.renderedFrames)*10;releasePause?.();}
      }
      if(['turn-cancelled','standby','playback-failed'].includes(e.type))fail('PLAYBACK_CANCELLED');
      if(e.type==='playback-submitted'){
        if(!submitted||e.renderedFrames!==frames)fail('PLAYBACK_INVALID_RECEIPT');
        else resolveReceipt({renderedFrames:frames});
      }
    };
    const retired=e=>{if(e.generation===key.generation)fail('PLAYBACK_WORKER_EXITED');};
    signal.addEventListener('abort',abort,{once:true});
    this.worker.on('event',event);this.worker.on('closed',retired);this.worker.on('fault',retired);
    // Progress extends only the inactivity deadline. A separate hard cap still
    // prevents a never-ending producer from owning the device indefinitely.
    let timeout=setTimeout(()=>fail('PLAYBACK_TIMEOUT'),this.playbackTimeoutMs);
    const absoluteTimeout=setTimeout(()=>fail('PLAYBACK_TURN_LIMIT'),this.maxDurationMs);
    const progressed=()=>{clearTimeout(timeout);timeout=setTimeout(()=>fail('PLAYBACK_TIMEOUT'),this.playbackTimeoutMs);};
    const waitForResume=async()=>{while(paused){await Promise.race([pauseGate,cancelled]);combined.throwIfAborted();}};
    const sendAudio=async pcm=>{
      await waitForResume();
      combined.throwIfAborted();
      // Fill a bounded reservoir while speech is already playing. The first
      // packet goes immediately; this adds headroom, not an onset delay.
      const wait=nextAt-performance.now()-this.leadMs;
      if(wait>0)await delay(wait,undefined,{signal:combined});
      combined.throwIfAborted();
      await waitForResume();
      scaleOwnedPcm(pcm,gain);
      await sendReady('playback-audio',{sequence:sequence++,pcm},()=>{meter.offer(pcm);frames+=pcm.length/320;});
      progressed();
      nextAt=Math.max(nextAt,performance.now())+pcm.length/32;
    };
    try{
      await sendReady('playback-begin');
      while(true){
        combined.throwIfAborted();
        await waitForResume();
        let stalled;
        const item=await Promise.race([Promise.resolve().then(()=>iterator.next()),cancelled,
          new Promise((_,reject)=>{stalled=setTimeout(()=>reject(Error('PLAYBACK_SOURCE_TIMEOUT')),this.sourceTimeoutMs);})
        ]).finally(()=>clearTimeout(stalled));
        combined.throwIfAborted();
        if(item.done)break;
        const chunk=item.value;
        if(!Buffer.isBuffer(chunk)||!chunk.length||chunk.length>6400||bytes+chunk.length>5760000)throw Error('PLAYBACK_INVALID_PCM');
        bytes+=chunk.length;
        const pending=Buffer.concat([carry,chunk]);carry.fill(0);carry=Buffer.alloc(0);
        try{
          let offset=0;
          while(pending.length-offset>=320){
            const size=Math.min(3200,Math.floor((pending.length-offset)/320)*320);
            await sendAudio(pending.subarray(offset,offset+size));offset+=size;
          }
          carry=Buffer.from(pending.subarray(offset));
        }finally{pending.fill(0);}
      }
      if(!bytes||bytes%2)throw Error('PLAYBACK_INVALID_PCM');
      if(carry.length){const padded=Buffer.alloc(320);carry.copy(padded);try{await sendAudio(padded);}finally{padded.fill(0);}}
      combined.throwIfAborted();submitted=true;await sendReady('playback-end',{sequence});
      return await Promise.race([receipt,cancelled]);
    }finally{
      meter.dispose();
      clearTimeout(timeout);clearTimeout(absoluteTimeout);signal.removeEventListener('abort',abort);
      this.worker.off('event',event);this.worker.off('closed',retired);this.worker.off('fault',retired);
      try{send('playback-cancel');}catch{}
      controller.abort();releasePause?.();carry.fill(0);
      // Do not wait for an uncooperative producer before releasing this turn.
      try{void Promise.resolve(iterator.return?.()).catch(()=>{});}catch{}
      if(this.active===run)this.active=null;
    }
  }
  async play(key, pcm, signal) {
    signal.throwIfAborted();
    if (![key.generation,key.audioGeneration,key.turn].every(n=>Number.isSafeInteger(n)&&n>0) || !Buffer.isBuffer(pcm) || !pcm.length || pcm.length%2 || pcm.length>960000) throw Error('PLAYBACK_INVALID_INPUT');
    if (this.active) throw Error('PLAYBACK_ALREADY_ACTIVE');
    const gain=readGain(this.readVolume);
    const audio = Buffer.alloc(Math.ceil(pcm.length/320)*320); pcm.copy(audio); scaleOwnedPcm(audio,gain);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal,controller.signal]);
    const run = { controller, key: { ...key } }; this.active=run;
    const meter=createPortraitPlaybackMeter(this.worker,key,this.onLevel);
    let submitted=false, resolveReceipt, rejectReceipt;
    const receipt=new Promise((resolve,reject)=>{resolveReceipt=resolve;rejectReceipt=reject;});
    void receipt.catch(()=>{});
    const send=(type,extra={})=>this.worker.playback({...key,type,...extra});
    const fail=code=>{rejectReceipt(Error(code));controller.abort();};
    const matches=event=>event.generation===key.generation&&event.audioGeneration===key.audioGeneration&&event.turn===key.turn;
    const event=event=>{
      if (event.generation!==key.generation) return;
      if (event.type==='turn-start' && !matches(event)) {fail('PLAYBACK_SUPERSEDED');return;}
      if (!matches(event)) return;
      if (['turn-cancelled','standby','playback-failed'].includes(event.type)) fail('PLAYBACK_CANCELLED');
      if (event.type==='playback-submitted') {
        if (!submitted || event.renderedFrames!==audio.length/320) fail('PLAYBACK_INVALID_RECEIPT');
        else resolveReceipt({renderedFrames:event.renderedFrames});
      }
    };
    const retired=event=>{if(event.generation===key.generation)fail('PLAYBACK_WORKER_EXITED');};
    const aborted=()=>rejectReceipt(Error('PLAYBACK_CANCELLED'));
    combined.addEventListener('abort',aborted,{once:true});
    this.worker.on('event',event);this.worker.on('closed',retired);this.worker.on('fault',retired);
    const timeout=setTimeout(()=>fail('PLAYBACK_TIMEOUT'),audio.length/32+5000);
    try {
      if(!send('playback-begin'))throw Error('PLAYBACK_SEND_FAILED');
      let sequence=0;
      for(let offset=0;offset<audio.length;offset+=3200){
        combined.throwIfAborted();
        const packet=audio.subarray(offset,offset+3200);
        if(!send('playback-audio',{sequence:sequence++,pcm:packet}))throw Error('PLAYBACK_SEND_FAILED');
        meter.offer(packet);
        // Do not catch up after a stalled event loop by flooding the device queue.
        if(offset+3200<audio.length)await delay(100,undefined,{signal:combined});
      }
      combined.throwIfAborted();submitted=true;
      if(!send('playback-end',{sequence}))throw Error('PLAYBACK_SEND_FAILED');
      return await receipt;
    } finally {
      meter.dispose();
      clearTimeout(timeout);combined.removeEventListener('abort',aborted);
      this.worker.off('event',event);this.worker.off('closed',retired);this.worker.off('fault',retired);
      try{send('playback-cancel');}catch{}
      controller.abort();audio.fill(0);
      if(this.active===run)this.active=null;
    }
  }
}
module.exports={NativePlayback};
