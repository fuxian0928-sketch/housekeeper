const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const {bufferPcmStart,localSpeechStartPolicy}=require('./pcm-start-buffer.cjs');

/** Trusted main-process host: one warm worker, bounded PCM credits, no device ownership. */
function createLocalSpeechProvider({python,workerRoot,modelRoot,spawnProcess=spawn,startupMs=45000,onFault}) {
  for(const value of [python,workerRoot,modelRoot])if(typeof value!=='string'||!path.isAbsolute(value))throw Error('VOICE_LOCAL_RESOURCE_MISSING');
  const env={PYTHONIOENCODING:'utf-8',PYTHONNOUSERSITE:'1',HF_HUB_OFFLINE:'1',OMP_NUM_THREADS:'2'};
  for(const name of ['SystemRoot','WINDIR','PATH','TEMP','TMP','APPDATA','USERPROFILE'])if(process.env[name])env[name]=process.env[name];
  const child=spawnProcess(python,['-E','-s','-B',path.join(workerRoot,'scripts/voice-lab/local_speech_worker.py'),'--models',modelRoot,'--threads','2'],{cwd:workerRoot,windowsHide:true,stdio:['pipe','pipe','pipe'],env});
  let stopped=false,started=false,buffer='',resolveReady,rejectReady,exitResolve;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  void ready.catch(()=>{});
  const exited=new Promise(resolve=>{exitResolve=resolve;});
  const sessions=new Map();
  const timer=setTimeout(()=>fail('VOICE_LOCAL_START_TIMEOUT'),startupMs);timer.unref?.();
  function send(event) {
    if(stopped||!child.stdin.writable)return false;
    if(child.stdin.writableLength>131072){fail('VOICE_LOCAL_INPUT_LIMIT');return false;}
    try{return child.stdin.write(JSON.stringify(event)+'\n')!==undefined;}catch{fail('VOICE_LOCAL_CLOSED');return false;}
  }
  function fail(code) {
    if(stopped)return;
    stopped=true;clearTimeout(timer);rejectReady(Error(code));
    for(const listener of [...sessions.values()])listener({type:'error',code});
    sessions.clear();child.kill();
    try{onFault?.(code);}catch{}
  }
  child.once('error',()=>fail('VOICE_LOCAL_PROCESS_FAILED'));
  child.once('exit',()=>{exitResolve();if(!stopped)fail('VOICE_LOCAL_PROCESS_EXITED');});
  child.stdin.on('error',()=>fail('VOICE_LOCAL_CLOSED'));
  child.stderr.on('data',()=>{}); // No provider text, paths, credentials or audio in application logs.
  child.stdout.on('data',chunk=>{
    if(stopped)return;
    buffer+=chunk.toString('utf8');
    if(buffer.length>262144){fail('VOICE_LOCAL_EVENT_LIMIT');return;}
    let end;
    while((end=buffer.indexOf('\n'))>=0) {
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
      let event;try{event=JSON.parse(line);}catch{fail('VOICE_LOCAL_PROTOCOL');return;}
      if(event.type==='ready') {
        if(started||event.protocol!==1||event.sampleRate!==16000||event.channels!==1||event.voice!=='xiwei-sweet-soft'){fail('VOICE_LOCAL_FORMAT');return;}
        started=true;clearTimeout(timer);resolveReady();continue;
      }
      if(event.type==='fatal'){fail('VOICE_LOCAL_START_FAILED');return;}
      if(typeof event.id==='string')sessions.get(event.id)?.(event);
    }
  });
  function register(id,listener,open) {
    sessions.set(id,listener);
    void ready.then(()=>{if(sessions.has(id)&&!send({type:open,id}))listener({type:'error'});},()=>listener({type:'error'}));
  }
  function remove(id) {sessions.delete(id);send({type:'cancel',id});}
  function connectAsr(options) {
    const id=randomUUID();let bytes=0,closed=false,finishing=false,configured=false,resolve,reject,readyResolve,readyReject;
    const pending=[];
    const configuredPromise=new Promise((ok,no)=>{readyResolve=ok;readyReject=no;});void configuredPromise.catch(()=>{});
    const result=new Promise((ok,no)=>{resolve=ok;reject=no;});void result.catch(()=>{});
    let deadline=setTimeout(()=>abort('ASR_LOCAL_TOTAL_TIMEOUT'),40000);
    const cancel=()=>abort('ASR_CANCELLED');
    function cleanup(){clearTimeout(deadline);options.signal.removeEventListener('abort',cancel);remove(id);pending.length=0;}
    function abort(code){if(closed)return;closed=true;cleanup();const e=Error(code);readyReject(e);reject(e);}
    function flush(){if(!configured||closed)return;for(const pcm of pending.splice(0))if(!send({type:'asr-pcm',id,pcm:pcm.toString('base64')})){abort('ASR_LOCAL_SEND_FAILED');return;}if(finishing)send({type:'asr-finish',id});}
    options.signal.addEventListener('abort',cancel,{once:true});
    register(id,event=>{
      if(closed)return;
      if(event.type==='opened'){configured=true;readyResolve();flush();}
      else if(event.type==='partial'&&typeof event.text==='string'&&event.text.length<=8000){try{options.onPartial?.({text:event.text,final:false});}catch{}}
      else if(event.type==='final') {
        if(!finishing||typeof event.text!=='string'||event.text.length>8000||event.audioBytes!==bytes){abort('ASR_LOCAL_INVALID_FINAL');return;}
        closed=true;cleanup();resolve({text:event.text.trim(),final:true,audioBytes:bytes});
      }else if(event.type==='error')abort('ASR_LOCAL_FAILED');
    },'asr-open');
    if(options.signal.aborted)cancel();
    return {ready:configuredPromise,result,append(pcm,capturedAt=performance.now()){
      if(closed||finishing)return false;
      if(!Buffer.isBuffer(pcm)||!pcm.length||pcm.length>6400||pcm.length%2||!Number.isFinite(capturedAt)||capturedAt>performance.now()+10||performance.now()-capturedAt>2000||bytes+pcm.length>1024000||(!configured&&pending.reduce((n,p)=>n+p.length,0)+pcm.length>64000)){abort('ASR_LOCAL_INVALID_PCM');return false;}
      bytes+=pcm.length;pending.push(Buffer.from(pcm));flush();return !closed;
    },finish(){if(!finishing&&!closed){finishing=true;clearTimeout(deadline);deadline=setTimeout(()=>abort('ASR_LOCAL_FINAL_TIMEOUT'),5000);flush();}return result;},cancel};
  }
  function connectTts(options) {
    const id=randomUUID();let configured=false,ended=false,done=false,error=null,consuming=false,total=0,bytes=0,queued=0,wake,readyResolve,readyReject;
    const chunks=[];
    let rawSeen=false,voicedSeen=false;
    const metric=(stage,values)=>{try{options.onMetric?.({stage,...(values?{values}:{})});}catch{}};
    const configuredPromise=new Promise((ok,no)=>{readyResolve=ok;readyReject=no;});void configuredPromise.catch(()=>{});
    let deadline,absolute,opening=setTimeout(()=>abort('TTS_LOCAL_OPEN_TIMEOUT'),10000);
    function notify(){const fn=wake;wake=undefined;fn?.();}
    function cleanup(){clearTimeout(opening);clearTimeout(deadline);clearTimeout(absolute);options.signal.removeEventListener('abort',cancel);remove(id);}
    function progress(){clearTimeout(deadline);deadline=setTimeout(()=>abort('TTS_LOCAL_STALLED'),30000);}
    function abort(code){if(error)return;error=Error(code);cleanup();for(const pcm of chunks)pcm.fill(0);chunks.length=0;queued=0;readyReject(error);notify();}
    const cancel=()=>abort('TTS_CANCELLED');
    options.signal.addEventListener('abort',cancel,{once:true});
    register(id,event=>{
      if(error)return;
      if(event.type==='opened'){clearTimeout(opening);configured=true;readyResolve();}
      else if(event.type==='pcm') {
        if(done||!total||typeof event.pcm!=='string'||event.pcm.length>9000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.pcm)){abort('TTS_LOCAL_INVALID_PCM');return;}
        const pcm=Buffer.from(event.pcm,'base64');
        if(!pcm.length||pcm.length%2||queued+pcm.length>96000||(bytes+=pcm.length)>5760000){abort('TTS_LOCAL_AUDIO_LIMIT');return;}
        if(!rawSeen){rawSeen=true;metric('tts-first-raw-pcm');}
        if(!voicedSeen){for(let offset=0;offset<pcm.length;offset+=2)if(Math.abs(pcm.readInt16LE(offset))>8){voicedSeen=true;metric('tts-first-voiced-pcm');break;}}
        chunks.push(pcm);queued+=pcm.length;progress();notify();
      }else if(event.type==='done'){
        if(!ended||!bytes){abort('TTS_LOCAL_MISSING_AUDIO');return;}
        if([event.synthesisMs,event.creditWaitMs,event.segments,event.trimmedMs].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=240000))metric('tts-production',{synthesisMs:event.synthesisMs,creditWaitMs:event.creditWaitMs,audioMs:bytes/32,segments:event.segments,trimmedMs:event.trimmedMs});
        done=true;clearTimeout(deadline);clearTimeout(absolute);sessions.delete(id);notify();
      }else if(event.type==='error')abort('TTS_LOCAL_FAILED');
    },'tts-open');
    if(options.signal.aborted)cancel();
    return {ready:configuredPromise,append(text){
      if(!configured||ended||done||error)return false;
      if(typeof text!=='string'||!text.trim()||(total+=text.length)>3000){abort('TTS_LOCAL_TEXT_LIMIT');return false;}
      // Model thinking is not synthesis time. Keep the warm session ready, and
      // start its audio budget with the first real sentence, without delaying it.
      absolute??=setTimeout(()=>abort('TTS_LOCAL_TURN_TIMEOUT'),240000);
      progress();return send({type:'tts-text',id,text});
    },finish(){if(!configured||ended||done||error||!total)return false;ended=true;progress();return send({type:'tts-finish',id});},cancel,
    audio:{async *[Symbol.asyncIterator](){
      if(consuming)throw Error('TTS_SINGLE_CONSUMER');consuming=true;
      const raw={async *[Symbol.asyncIterator](){while(true){options.signal.throwIfAborted();if(error)throw error;const pcm=chunks.shift();if(pcm){queued-=pcm.length;yield pcm;if(!done&&!error)send({type:'credit',id});}else if(done)return;else await new Promise(resolve=>{wake=resolve;});}}};
      // Prime before exposing the first PCM to the response pipeline, so the
      // speaking state starts only when this bounded reservoir is ready.
      try{yield* bufferPcmStart(raw,{signal:options.signal,targetMs:stats=>localSpeechStartPolicy(total,stats).targetMs,maxWaitMs:()=>localSpeechStartPolicy(total).maxWaitMs,onReady:stats=>metric('tts-buffer-ready',{bufferedMs:stats.bufferedMs,bufferWaitMs:stats.waitMs})});}
      finally{if(!done||error)cancel();else cleanup();for(const pcm of chunks)pcm.fill(0);chunks.length=0;}
    }}};
  }
  return {ready,connectAsr,connectTts,status:()=>({ready:started&&!stopped,voice:'xiwei-sweet-soft',location:'local'}),async close(){
    if(!stopped){stopped=true;clearTimeout(timer);rejectReady(Error('VOICE_LOCAL_CLOSED'));for(const fn of [...sessions.values()])fn({type:'error'});sessions.clear();child.stdin.end();}
    await Promise.race([exited,new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},3000);timer.unref?.();})]);
  }};
}
module.exports={createLocalSpeechProvider};
