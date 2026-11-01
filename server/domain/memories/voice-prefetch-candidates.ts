import { normalizePrefetchQuery as normalize } from './prefetch-query.js';
import { randomUUID } from 'node:crypto';
import { database } from '../../db.js';
import { ExistingMemoryContextProvider, type MemoryContext, type MemoryContextProvider } from './memory-context.js';

export type VoicePrefetchRequest={query:string;mode:'life'|'work'|'auto';projectId:string|null;conversationId:string|null};

type Candidate={request:VoicePrefetchRequest;context:MemoryContext;revision:string;profileRevision?:string;expires:number};
function revision(){
  const row=database.prepare('SELECT revision FROM memory_context_revision WHERE id=1').get() as {revision:string}|undefined;
  if(!row)throw Error('PREFETCH_REVISION_UNAVAILABLE');
  return row.revision;
}
function identity(request:VoicePrefetchRequest){return JSON.stringify([request.mode,request.projectId,request.conversationId]);}

/** Cache owned by the trusted chat service; callers receive only an opaque token. */
export class VoicePrefetchCandidates {
  private entries=new Map<string,Candidate>();
  constructor(private readonly provider:MemoryContextProvider=new ExistingMemoryContextProvider(),private readonly now=Date.now, private readonly projectProfile?:()=>{provider:MemoryContextProvider;revision:string}){}
  private prune(){for(const [token,row] of this.entries)if(row.expires<=this.now())this.entries.delete(token);}
  async prepare(request:VoicePrefetchRequest,signal:AbortSignal){
    signal.throwIfAborted();this.prune();
    if(!request||typeof request.query!=='string'||request.query.length>4000||normalize(request.query).length<6||!['life','work','auto'].includes(request.mode)||[request.projectId,request.conversationId].some(value=>value!==null&&(typeof value!=='string'||!value||value.length>200)))throw Error('PREFETCH_REQUEST_INVALID');
    request={...request,projectId:request.mode==='life'?null:request.projectId};
    let projects:Array<{id:string}> = [];
    if(request.mode!=='life'){
      projects=(request.projectId?database.prepare('SELECT id FROM projects WHERE id=? AND deleted_at IS NULL').all(request.projectId):database.prepare('SELECT id FROM projects WHERE deleted_at IS NULL').all()) as Array<{id:string}>;
      if(request.projectId&&!projects.length)throw Error('PREFETCH_PROJECT_UNAVAILABLE');
    }
    const profile=request.mode!=='life' && request.projectId ? this.projectProfile?.() : undefined;
    const before=revision(),began=this.now();
    const context=await (profile?.provider??this.provider).retrieve({query:request.query,projectIds:projects.map(row=>row.id),limit:profile?32:12,signal});
    if(profile && profile.revision!==this.projectProfile?.().revision)throw Error('PREFETCH_PROFILE_CHANGED');
    signal.throwIfAborted();if(before!==revision()||JSON.stringify(context).length>24000)throw Error('PREFETCH_CHANGED');
    // Time can change eligibility without a database write. Bound by the earliest
    // memory validity transition, conservatively across the entire database.
    const timestamp=new Date(began).toISOString();
    const transition=database.prepare(`SELECT MIN(t) AS t FROM (SELECT valid_from AS t FROM memories WHERE valid_from>? UNION ALL SELECT valid_until AS t FROM memories WHERE valid_until>=?)`).get(timestamp,timestamp) as {t:string|null};
    const expires=Math.min(began+10000,transition.t?Date.parse(transition.t):Infinity);
    if(!Number.isFinite(expires)||expires<=this.now())throw Error('PREFETCH_EXPIRED');
    while(this.entries.size>=128)this.entries.delete(this.entries.keys().next().value!);
    const token=randomUUID();this.entries.set(token,{request:{...request},context:structuredClone(context),revision:before,profileRevision:profile?.revision,expires});
    return {token};
  }
  consume(token:unknown,request:VoicePrefetchRequest):MemoryContext|undefined{
    this.prune();if(typeof token!=='string')return;
    const row=this.entries.get(token);if(!row)return;
    this.entries.delete(token);
    if(identity(row.request)!==identity({...request,projectId:request.mode==='life'?null:request.projectId})||normalize(row.request.query)!==normalize(request.query)||row.revision!==revision())return;
    try { if(row.profileRevision!==undefined && row.profileRevision!==this.projectProfile?.().revision)return; }
    catch { return; } // Optional speculation must not fail a foreground answer.
    return structuredClone(row.context);
  }
}
