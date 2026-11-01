import type {WebSearchQuery,WebSearchResult} from './web-search-provider.js';

function endpoint(base:string,action:'search'|'fetch'){
  const url=new URL(base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('搜索服务地址无效。');
  return base.replace(/\/+$/,'')+(/\/v1\/?$/.test(url.pathname)?'/tools/':'/v1/tools/')+action;
}
function publicUrl(value:unknown){
  if(typeof value!=='string'||value.length>8192)return null;
  try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;return url.href;}catch{return null;}
}
export class DeepSeekWebSearchProvider {
  constructor(private readonly apiKey:string,private readonly baseUrl:string){}
  private async request(action:'search'|'fetch',body:unknown,signal?:AbortSignal){
    signal?.throwIfAborted();
    const response=await fetch(endpoint(this.baseUrl,action),{method:'POST',headers:{Authorization:`Bearer ${this.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000),redirect:'error'});
    if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(response.status===404?'当前服务未开放 DeepSeek Search / Fetch，请使用官方地址或支持这些接口的中转服务。':`DeepSeek 联网接口返回 ${response.status}，请检查对话连接、余额与服务权限。`),{status:response.status});}
    const limit=1_000_000,reader=response.body?.getReader();if(!reader)throw Error('联网接口未返回结果。');
    const parts:Uint8Array[]=[];let bytes=0;
    try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>limit)throw Error('联网结果超过处理上限，请缩小查询。');parts.push(part.value);}return JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string,unknown>;}
    finally{await reader.cancel().catch(()=>{});}
  }
  async search(input:WebSearchQuery,signal?:AbortSignal):Promise<WebSearchResult[]>{
    const query=[...input.query.trim()].slice(0,128).join('');if(!query)throw Error('请提供搜索问题。');
    let qualified=query;
    if(input.timeRange){const days={day:1,week:7,month:30,year:365}[input.timeRange];const after=new Date(Date.now()-days*86400000).toISOString().slice(0,10);qualified=[...query].slice(0,100).join('')+` after:${after}`;}
    const payload=await this.request('search',{query:qualified,count:6,need_content:true},signal);
    const results:WebSearchResult[]=[];
    for(const item of Array.isArray(payload.results)?payload.results:[]){
      if(!item||typeof item!=='object')continue;const row=item as Record<string,unknown>,url=publicUrl(row.url);
      if(!url||typeof row.title!=='string'||!row.title.trim())continue;
      const content=[row.content,row.summary,row.snippet].find(value=>typeof value==='string'&&value.trim()) as string|undefined;
      results.push({title:row.title.trim().slice(0,240),url,content:content?.trim().slice(0,4000)??'',score:typeof row.rerank_score==='number'&&Number.isFinite(row.rerank_score)?Math.max(0,Math.min(1,row.rerank_score/3)):0,publishedAt:typeof row.date==='string'?row.date:null,query:input.query.slice(0,600),purpose:input.purpose??''});
      if(results.length===6)break;
    }
    return results;
  }
  async fetchPage(url:string,signal?:AbortSignal){
    const target=publicUrl(url);if(!target)throw Error('请提供不含账号密码的公开网页地址。');
    const payload=await this.request('fetch',{url:target},signal);
    if(typeof payload.content!=='string'||!payload.content.trim())throw Error('该网页没有可读取的正文。');
    return {title:typeof payload.title==='string'?payload.title.slice(0,240):target,url:target,content:payload.content.slice(0,20000),truncated:payload.content.length>20000};
  }
  async searchMany(inputs:WebSearchQuery[],signal?:AbortSignal){
    const settled=await Promise.allSettled(inputs.slice(0,3).map(input=>this.search(input,signal))),byUrl=new Map<string,WebSearchResult>(),failedQueries:Array<{query:string;message:string}>=[];
    settled.forEach((item,index)=>{if(item.status==='rejected'){failedQueries.push({query:inputs[index].query,message:item.reason instanceof Error?item.reason.message:'搜索未完成'});return;}for(const result of item.value){if(!byUrl.has(result.url)||(byUrl.get(result.url)!.score<result.score))byUrl.set(result.url,result);}});
    signal?.throwIfAborted();return{results:[...byUrl.values()].sort((a,b)=>b.score-a.score).slice(0,12),failedQueries};
  }
}
