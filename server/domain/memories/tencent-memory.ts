import {safeMemoryText} from './work-memory.js';

export type TencentMemoryConfig={endpoint:string;apiKey:string;serviceId:string;teamId:string;agentId:string;userId:string;timeoutMs?:number};
export type ExternalMemoryCandidate={externalId:string;content:string;projectId:string|null;updatedAt:string|null;source:'tencentdb';verification:'unverified';requiresSourceCheck:true};

/** v3 L1 read adapter. It does not start another extraction pipeline or migrate personal data. */
export class TencentMemoryReader {
  private readonly endpoint:string;private failures=0;private retryAfter=0;private connected=false;private lastError='';
  constructor(private readonly config:TencentMemoryConfig){
    for(const key of ['endpoint','apiKey','serviceId','teamId','agentId','userId'] as const)if(!config[key]?.trim())throw Error(`TENCENT_MEMORY_MISSING_${key.toUpperCase()}`);
    const url=new URL(config.endpoint);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('TENCENT_MEMORY_ENDPOINT_INVALID');
    if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('TENCENT_MEMORY_HTTPS_REQUIRED');
    this.endpoint=url.toString().replace(/\/+$/,'');
  }
  status(){return{configured:true,connected:this.connected,circuitOpen:Date.now()<this.retryAfter,lastError:this.lastError,mode:'read-candidates',captureEnabled:false};}
  async recall(query:string,projectId:string|null,signal?:AbortSignal):Promise<ExternalMemoryCandidate[]>{
    signal?.throwIfAborted();if(Date.now()<this.retryAfter)throw Error('TENCENT_MEMORY_CIRCUIT_OPEN');
    const timeout=Math.min(2000,Math.max(50,this.config.timeoutMs??600));
    try{
      const response=await fetch(`${this.endpoint}/v3/atomic/search`,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${this.config.apiKey}`,'x-tdai-service-id':this.config.serviceId,'Content-Type':'application/json'},body:JSON.stringify({team_id:this.config.teamId,agent_id:this.config.agentId,user_id:this.config.userId,task_id:projectId?`xiwei-project:${projectId}`:'xiwei-personal',query:safeMemoryText(query,2000),limit:4}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)});
      if(!response.ok)throw Error(`TENCENT_MEMORY_HTTP_${response.status}`);
      const reader=response.body?.getReader();if(!reader)throw Error('TENCENT_MEMORY_EMPTY_RESPONSE');
      const chunks:Uint8Array[]=[];let size=0;
      try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>256*1024){await reader.cancel();throw Error('TENCENT_MEMORY_RESPONSE_TOO_LARGE');}chunks.push(next.value);}}finally{reader.releaseLock();}
      const envelope=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {code?:number;data?:{items?:Array<Record<string,unknown>>}};
      if(envelope.code!==0||!Array.isArray(envelope.data?.items))throw Error('TENCENT_MEMORY_PROTOCOL_MISMATCH');
      this.failures=0;this.retryAfter=0;this.connected=true;this.lastError='';
      return envelope.data.items.slice(0,4).filter(item=>typeof item.id==='string'&&typeof item.content==='string'&&item.content.trim()).map(item=>({externalId:String(item.id).slice(0,160),content:safeMemoryText(item.content,1800),projectId,updatedAt:typeof item.updated_at==='string'&&!Number.isNaN(Date.parse(item.updated_at))?item.updated_at:null,source:'tencentdb' as const,verification:'unverified' as const,requiresSourceCheck:true as const}));
    }catch(error){
      if(signal?.aborted)throw signal.reason;
      this.connected=false;this.failures++;this.lastError=error instanceof Error&&/^TENCENT_MEMORY_[A-Z0-9_]+$/.test(error.message)?error.message:'TENCENT_MEMORY_UNAVAILABLE';
      if(this.failures>=3)this.retryAfter=Date.now()+30_000;throw Error(this.lastError);
    }
  }
}
export function tencentMemoryFromEnvironment(env:NodeJS.ProcessEnv=process.env){
  if(!env.AI_SECRETARY_MEMORY_TENCENT_ENDPOINT)return{reader:null,configurationError:null};
  try{return{reader:new TencentMemoryReader({endpoint:env.AI_SECRETARY_MEMORY_TENCENT_ENDPOINT,apiKey:env.AI_SECRETARY_MEMORY_TENCENT_API_KEY??'',serviceId:env.AI_SECRETARY_MEMORY_TENCENT_SERVICE_ID??'',teamId:env.AI_SECRETARY_MEMORY_TENCENT_TEAM_ID??'',agentId:env.AI_SECRETARY_MEMORY_TENCENT_AGENT_ID??'',userId:env.AI_SECRETARY_MEMORY_TENCENT_USER_ID??''}),configurationError:null};}catch(error){return{reader:null,configurationError:error instanceof Error&&/^TENCENT_MEMORY_[A-Z0-9_]+$/.test(error.message)?error.message:'TENCENT_MEMORY_CONFIG_INVALID'};}
}
