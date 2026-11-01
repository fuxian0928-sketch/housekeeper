/** Bound whole fields instead of cutting JSON in the middle of evidence or status. */
export function encodeAgentContext(value:unknown,maxLength=24_000):string {
  const priority=['memoryRules','interaction','recallProjectHint','memoryRetrieval','memories','workContext','historyEvidence','memoryCandidates','summary','referencedDocuments'];
  let final:Record<string,unknown>={};
  for(const stringLimit of [2000,1000,500,240]){
    let clipped=false;const seen=new WeakSet<object>();
    const compact=(item:unknown,depth=0):unknown=>{
      if(typeof item==='string'){if(item.length>stringLimit)clipped=true;return item.slice(0,stringLimit);}
      if(item===null||typeof item==='boolean')return item;
      if(typeof item==='number')return Number.isFinite(item)?item:null;
      if(!item||typeof item!=='object')return null;
      if(depth>7||seen.has(item)){clipped=true;return '[内容已省略]';}seen.add(item);
      let result:unknown;
      if(Array.isArray(item)){if(item.length>12)clipped=true;result=item.slice(0,12).map(child=>compact(child,depth+1));}
      else {const entries=Object.entries(item);if(entries.length>32)clipped=true;result=Object.fromEntries(entries.slice(0,32).map(([key,child])=>[key.slice(0,120),compact(child,depth+1)]));}
      seen.delete(item);return result;
    };
    const bounded=compact(value);
    final=bounded&&typeof bounded==='object'&&!Array.isArray(bounded)?bounded as Record<string,unknown>:{data:bounded};
    if(clipped)final.contextTruncated=true;
    const encoded=JSON.stringify(final);if(encoded.length<=maxLength)return encoded;
  }
  const output:Record<string,unknown>={contextTruncated:true},omitted:string[]=[];
  const keys=[...new Set([...priority,...Object.keys(final)])];
  for(const key of keys){
    if(!(key in final))continue;
    if(JSON.stringify({...output,[key]:final[key],omittedFields:omitted}).length<=maxLength-200)output[key]=final[key];
    else omitted.push(key);
  }
  output.omittedFields=omitted;
  return JSON.stringify(output);
}
