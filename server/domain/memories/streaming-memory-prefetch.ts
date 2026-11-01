import { normalizePrefetchQuery as normalize } from './prefetch-query.js';
import type { MemoryContext, MemoryContextRequest } from './memory-context.js';

type Scope={ownerId:string;projectIds:readonly string[];revision:string};
type Turn<T>={id:string;scope:Scope;attempts:number;maxAttempts:1|2;revision:number;query:string;text:string;timer?:ReturnType<typeof setTimeout>;controller?:AbortController;result?:{query:string;value:T};ended:boolean};

const scopeKey=(scope:Scope)=>JSON.stringify([scope.ownerId,[...new Set(scope.projectIds)].sort(),scope.revision]);

/** Read-only speculation; it never calls an Agent, writes memory, or performs tools.
 * Trusted owner supplies current scope/data revision again at finalization.
 * A miss returns immediately so speculative work cannot delay the final query.
 */
export class StreamingMemoryPrefetch<T = MemoryContext> {
  private turn?:Turn<T>;
  private inFlight=0;
  private stats={requests:0,hits:0,discarded:0,cancelled:0};
  constructor(private readonly provider:{retrieve(request:MemoryContextRequest):Promise<T>}, private readonly debounceMs=300,private readonly budgetMs=1000) {
    if(!Number.isInteger(debounceMs)||debounceMs<1||debounceMs>1000||!Number.isInteger(budgetMs)||budgetMs<1||budgetMs>5000)throw Error('PREFETCH_BUDGET_INVALID');
  }
  start(id:string,scope:Scope,maxAttempts:1|2=2){
    this.cancel();
    if(maxAttempts!==1&&maxAttempts!==2)throw Error('PREFETCH_ATTEMPTS_INVALID');
    if(!id||id.length>200||!scope.ownerId||scope.ownerId.length>200||!scope.revision||scope.revision.length>200||scope.projectIds.length>500)throw Error('PREFETCH_SCOPE_INVALID');
    this.turn={id,scope:{...scope,projectIds:[...scope.projectIds]},attempts:0,maxAttempts,revision:0,query:'',text:'',ended:false};
  }
  partial(id:string,text:string){
    const turn=this.turn;if(!turn||turn.ended||turn.id!==id)return;
    if(typeof text!=='string'||text.length>4000)return;
    const query=normalize(text);if(query===turn.query)return;
    turn.query=query;turn.text=text;turn.revision++;
    if(turn.timer)clearTimeout(turn.timer);
    if(turn.result){this.stats.discarded++;turn.result=undefined;}
    if(turn.controller&&!turn.controller.signal.aborted){this.stats.cancelled++;turn.controller.abort();}
    if([...query].length<6||turn.attempts>=turn.maxAttempts)return;
    turn.timer=setTimeout(()=>{turn.timer=undefined;void this.run(turn);},this.debounceMs);
  }
  private async run(turn:Turn<T>){
    if(this.turn!==turn||turn.ended||turn.attempts>=turn.maxAttempts||this.inFlight)return;
    const query=turn.query,revision=turn.revision,controller=new AbortController();turn.controller=controller;
    turn.attempts++;this.stats.requests++;this.inFlight++;
    const timer=setTimeout(()=>controller.abort(),this.budgetMs);
    try{
      // Keep inFlight until the provider settles, even if it ignores cancellation.
      // This bounds physical concurrency instead of starting replacement requests.
      const value=await this.provider.retrieve({query:turn.text,projectIds:turn.scope.projectIds,limit:12,signal:controller.signal});
      if(controller.signal.aborted||this.turn!==turn||turn.ended||turn.revision!==revision){this.stats.discarded++;return;}
      if(JSON.stringify(value).length>24000){this.stats.discarded++;return;}
      turn.result={query,value:structuredClone(value)};
    }catch{this.stats.discarded++;}finally{
      clearTimeout(timer);this.inFlight--;if(turn.controller===controller)turn.controller=undefined;
      // If the replacement debounce fired during the old request, resume only after it settled.
      if(this.turn===turn&&!turn.ended&&turn.revision!==revision&&!turn.timer&&turn.attempts<turn.maxAttempts&&[...turn.query].length>=6)void this.run(turn);
      const current=this.turn;
      if(current&&current!==turn&&!current.ended&&!current.timer&&!current.controller&&!current.result&&current.attempts<current.maxAttempts&&[...current.query].length>=6)void this.run(current);
    }
  }
  finish(id:string,text:string,scope:Scope):T|undefined{
    const turn=this.turn;if(!turn||turn.ended||turn.id!==id)return;
    const result=turn.result;
    const matches=result && result.query===normalize(text) && scopeKey(scope)===scopeKey(turn.scope);
    turn.result=undefined;this.cancel();
    if(!matches){if(result)this.stats.discarded++;return;}
    this.stats.hits++;return structuredClone(result.value);
  }
  cancel(){
    const turn=this.turn;if(!turn)return;
    turn.ended=true;if(turn.timer)clearTimeout(turn.timer);
    if(turn.controller&&!turn.controller.signal.aborted){this.stats.cancelled++;turn.controller.abort();}
    this.turn=undefined;
  }
  metrics(){return {...this.stats,inFlight:this.inFlight};}
}
