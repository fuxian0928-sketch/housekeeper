// Device-submission evidence, never a claim that the user heard speech.
class NativePlaybackLedger {
  constructor(){this.active=null;this.records=[];this.high=[0,0,0];}
  observe(event){
    const key=[event.generation,event.audioGeneration,event.turn];
    if(!key.every(n=>Number.isSafeInteger(n)&&n>0))return false;
    const compare=(a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2];
    if(['turn-start','idle-farewell'].includes(event.type)){
      if(compare(key,this.high)<=0)return false;
      this.freeze('interrupted');this.high=key;
      this.active={generation:key[0],audioGeneration:key[1],turn:key[2],submittedSamples:0,offeredBytes:0,answerSubmittedSamples:0,progressSubmittedSamples:0,spans:[],attribution:'known',state:'pending',textAlignment:'unknown',audibility:'unverified'};
      this.records.push(this.active);if(this.records.length>64)this.records.shift();return true;
    }
    const record=this.active;
    if(!record||compare(key,[record.generation,record.audioGeneration,record.turn])!==0)return false;
    if(['playback-progress','playback-submitted'].includes(event.type)){
      const frames=event.renderedFrames;
      if(!Number.isSafeInteger(frames)||frames<1||frames>30000||frames*160<record.submittedSamples)return false;
      const maximum=event.type==='playback-submitted'?Math.ceil(record.offeredBytes/320):Math.floor(record.offeredBytes/320);
      if(frames>maximum){record.attribution='unknown';return false;}
      record.submittedSamples=frames*160;
      this.attribute(record);
      record.state='partial'; // Raw worker completion still needs the player's end/size validation.
      return true;
    }
    if(['turn-cancelled','standby','playback-failed'].includes(event.type)){this.freeze(event.type==='playback-failed'?'device-error':'interrupted');return true;}
    return false;
  }
  complete(key,frames){
    const r=this.active;
    if(!r||!['generation','audioGeneration','turn'].every(k=>key[k]===r[k])||!Number.isSafeInteger(frames)||frames<1||r.offeredBytes%2||frames!==Math.ceil(r.offeredBytes/320)||frames*160!==r.submittedSamples||r.attribution!=='known')return false;
    r.state='submitted';this.active=null;return true;
  }
  bind(key,conversationId,answerHash,assistantMessageId){
    const r=this.records.findLast(item=>['generation','audioGeneration','turn'].every(k=>item[k]===key[k]));
    if(!r||typeof assistantMessageId!=='string'||!assistantMessageId||assistantMessageId.length>200||typeof conversationId!=='string'||!conversationId||conversationId.length>200||typeof answerHash!=='string'||!/^[a-f0-9]{64}$/.test(answerHash))return false;
    if(r.assistantMessageId && (r.assistantMessageId!==assistantMessageId||r.conversationId!==conversationId||r.answerHash!==answerHash))return false;
    r.assistantMessageId=assistantMessageId;r.conversationId=conversationId;r.answerHash=answerHash;return true;
  }
  context(conversationId){
    const r=this.records.findLast(item=>item.conversationId===conversationId&&item.answerHash&&item.assistantMessageId);
    return r?{conversationId:r.conversationId,assistantMessageId:r.assistantMessageId,answerHash:r.answerHash,state:r.state,answerSubmittedSamples:r.answerSubmittedSamples,attribution:r.attribution}:null;
  }
  offer(key,kind,bytes){
    const r=this.active;
    if(!r||!['generation','audioGeneration','turn'].every(k=>key[k]===r[k])||!['answer','progress'].includes(kind)||!Number.isSafeInteger(bytes)||bytes<1||bytes>6400)return false;
    if(r.offeredBytes+bytes>5760000){r.attribution='unknown';return false;}
    const start=r.offeredBytes;r.offeredBytes+=bytes;
    const last=r.spans.at(-1);
    if(last?.kind===kind)last.end=r.offeredBytes;
    else if(r.spans.length<64)r.spans.push({kind,start,end:r.offeredBytes});
    else r.attribution='unknown';
    return true;
  }
  attribute(r){
    let answer=0,progress=0;
    if(r.submittedSamples*2>r.offeredBytes+319)r.attribution='unknown';
    const cursor=Math.min(r.submittedSamples*2,r.offeredBytes);
    for(const span of r.spans){const bytes=Math.max(0,Math.min(cursor,span.end)-span.start);if(span.kind==='answer')answer+=bytes;else progress+=bytes;}
    r.answerSubmittedSamples=Math.floor(answer/2);r.progressSubmittedSamples=Math.floor(progress/2);
  }
  freeze(state,generation){if(this.active&&(generation===undefined||generation===this.active.generation)){this.active.state=state;this.active=null;}}
  snapshot(){return this.records.map(({spans,...record})=>({...record}));}
}
module.exports={NativePlaybackLedger};
