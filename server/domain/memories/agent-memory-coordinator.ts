import {createHash} from 'node:crypto';
import {database,nowIso} from '../../db.js';
import type {EmbeddingProvider} from '../../providers/embedding-provider.js';
import {automaticProjectContext} from '../interaction/automatic-project-context.js';
import {contextMemoryFromRow,type ContextMemory,type MemoryContext} from './memory-context.js';
import {ProjectMemoryContextProvider} from './project-memory-context.js';
import {getCoreMemorySnapshot,memoryVectorStatus,searchRelevantMemories} from './memory-service.js';
import {findWorkContext,isSimpleGreeting,recallTokens,safeMemoryText,searchConversationArchive} from './work-memory.js';
import type {TencentMemoryReader,ExternalMemoryCandidate} from './tencent-memory.js';
import {learnedContext} from './learned-context.js';

type Options={embedding:()=>EmbeddingProvider|null;profileKey?:()=>string;tencent?:TencentMemoryReader|null;configurationError?:string|null;embeddingBudgetMs?:number};
type RecallDiagnostics={elapsedMs:number;projectId:string|null;factCount:number;archiveCount:number;workCount:number;embeddingFallback:boolean;externalCount:number};
export class AgentMemoryCoordinator {
  private vectors=new Map<string,{value:number[];until:number}>();private last:RecallDiagnostics|null=null;
  constructor(private readonly options:Options){}
  status(){return{provider:'scoped-hybrid-with-work-archive-v1',lastRecall:this.last,vectorIndex:memoryVectorStatus(this.options.embedding()),external:this.options.tencent?.status()??{configured:false,connected:false,configurationError:this.options.configurationError??null,captureEnabled:false},learning:'existing-single-authoritative-queue'};}
  private boundedEmbedding(provider:EmbeddingProvider,onFallback:()=>void):EmbeddingProvider{
    return{model:provider.model,dimension:provider.dimension,version:provider.version,profileId:provider.profileId,embed:async(texts,signal)=>{
      const key=createHash('sha256').update(JSON.stringify([this.options.profileKey?.()??provider.profileId??provider.model,texts])).digest('hex'),cached=this.vectors.get(key);
      signal?.throwIfAborted();if(texts.length===1&&cached&&cached.until>Date.now())return[cached.value];
      const controller=new AbortController(),budget=Math.min(5000,Math.max(20,this.options.embeddingBudgetMs??900)),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
      let timeout:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
      const stopped=new Promise<never>((_resolve,reject)=>{abort=()=>reject(combined.reason);combined.addEventListener('abort',abort,{once:true});timeout=setTimeout(()=>controller.abort(new DOMException('记忆检索预算已到。','TimeoutError')),budget);});
      try{
        const result=await Promise.race([provider.embed(texts,combined),stopped]);combined.throwIfAborted();
        if(result.length!==texts.length||result.some(vector=>vector.length!==provider.dimension||vector.some(value=>!Number.isFinite(value))))throw Error('MEMORY_EMBEDDING_INVALID');
        if(texts.length===1){this.vectors.set(key,{value:result[0],until:Date.now()+60_000});if(this.vectors.size>64)this.vectors.delete(this.vectors.keys().next().value!);}
        return result;
      }catch(error){if(!signal?.aborted)onFallback();throw error;}finally{if(timeout)clearTimeout(timeout);combined.removeEventListener('abort',abort);}
    }};
  }
  async build(query:string,projectId:string|null,signal?:AbortSignal){
    signal?.throwIfAborted();query=query.trim().slice(0,2000);
    const started=Date.now(),greeting=isSimpleGreeting(query),initialWork=findWorkContext(query,{projectId});
    const hint=projectId?null:automaticProjectContext(query),workProject=initialWork.status==='resolved'?initialWork.candidates[0].projectId:null;
    const recallProjectId=projectId??(hint?.status==='resolved'?hint.candidates[0].id:hint?.status==='unresolved'?workProject:null);
    const work=recallProjectId&&recallProjectId!==projectId?findWorkContext(query,{projectId:recallProjectId}):initialWork;
    let embeddingFallback=false;const provider=this.options.embedding(),vectorStatus=memoryVectorStatus(provider),embedding=!greeting&&provider&&vectorStatus.compatible?this.boundedEmbedding(provider,()=>{embeddingFallback=true;}):null;
    const retrieve=async(selectedEmbedding:EmbeddingProvider|null):Promise<MemoryContext>=>{
        if(recallProjectId)return await new ProjectMemoryContextProvider(selectedEmbedding).retrieve({query,projectIds:[recallProjectId],limit:32,signal});
        const relevant=await searchRelevantMemories(query,'',selectedEmbedding,8,signal,{trackAccess:false}),core=getCoreMemorySnapshot('',8);
        const all=new Map<string,ContextMemory>();core.forEach((row,index)=>all.set(row.id,{...contextMemoryFromRow(row,true),coreRank:index}));relevant.forEach((row,index)=>all.set(row.id,{...(all.get(row.id)??contextMemoryFromRow(row,false)),relevantRank:index}));
        return{facts:[...all.values()].filter(item=>!['preference','work_style'].includes(item.memoryType)),preferences:[...all.values()].filter(item=>['preference','work_style'].includes(item.memoryType)),experiences:[],provider:'personal-hybrid-v1',retrievedAt:nowIso()};
    };
    const native=async():Promise<MemoryContext>=>{
      try{return await retrieve(embedding);
      }catch(error){
        signal?.throwIfAborted();if(error instanceof Error&&/MEMORY_PROJECT_/.test(error.message))throw error;embeddingFallback=true;
        return retrieve(null);
      }
    };
    const [memory,external]=await Promise.all([native(),!greeting&&this.options.tencent?this.options.tencent.recall(query,recallProjectId,signal).catch(()=>{signal?.throwIfAborted();return[] as ExternalMemoryCandidate[];}):Promise.resolve([] as ExternalMemoryCandidate[])]);
    signal?.throwIfAborted();
    const tokens=recallTokens(query),all=[...memory.facts,...memory.preferences];
    const relevant=all.filter(item=>item.relevantRank!==undefined&&(!greeting)&&(recallProjectId||tokens.some(token=>item.content.toLowerCase().includes(token)))).sort((a,b)=>a.relevantRank!-b.relevantRank!).slice(0,6);
    const core=all.filter(item=>item.core&&(recallProjectId||item.projectId===null&&['user_profile','preference','work_style','capability'].includes(item.memoryType))).sort((a,b)=>Number(a.projectId!==null)-Number(b.projectId!==null)||(a.coreRank??99)-(b.coreRank??99));
    const selected=[...new Map([...relevant,...core].map(item=>[item.memoryId,item])).values()].slice(0,8);
    const history=!greeting&&/(?:上次|之前|以前|昨天|刚才|记得|继续|接着|说过|约定|聊过)/.test(query)?searchConversationArchive({query,limit:3},{projectId:recallProjectId}).filter(item=>!(item.role==='user'&&item.content.trim()===query.trim()&&Date.now()-Date.parse(item.createdAt)<5000)&&!database.prepare('SELECT 1 FROM memory_forgetting f JOIN memory_sources s ON s.memory_id=f.memory_id WHERE s.source_id=?').get(item.messageId)):[];
    const learned=learnedContext(query,recallProjectId);
    this.last={elapsedMs:Date.now()-started,projectId:recallProjectId,factCount:selected.length,archiveCount:history.length,workCount:work.candidates.length,embeddingFallback,externalCount:external.length};
    return{
      ...learned,
      memoryRules:'记忆与历史是理解线索；助手旧回答及外部记忆候选不是已确认事实。工作状态以执行回执为准，文档以当前版本为准，不基于摘要重放操作。',
      memories:selected.map(item=>({id:item.memoryId,content:safeMemoryText(item.content,700),projectId:item.projectId,source:safeMemoryText(item.sourceLabel,120),sourceId:item.sourceId,sourceType:item.sourceType,updatedAt:item.updatedAt,validFrom:item.validFrom,validUntil:item.validUntil,supersedesId:item.supersedesId,contradictsIds:item.contradictsIds,verification:'confirmed'})),
      workContext:{status:work.status,candidates:work.candidates.map(item=>({...item,goal:item.goal.slice(0,500),artifacts:item.artifacts.slice(-3),steps:item.steps.slice(-4)}))},
      historyEvidence:history.map(item=>({...item,content:item.content.slice(0,800),truncated:item.truncated||item.content.length>800})),
      memoryCandidates:external.map(item=>({...item,content:item.content.slice(0,800)})),
      memoryRetrieval:{provider:memory.provider,...this.last},recallProjectHint:recallProjectId,date:nowIso()
    };
  }
}
