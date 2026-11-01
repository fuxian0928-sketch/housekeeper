import type { AgentMessage, AgentModelTool, AgentModelTurn, AgentToolCall } from '../domain/agent/types.js';
import type { ReasoningEffort } from './llm-provider.js';
import { isDeepSeek, modelReasoning } from './model-reasoning.js';

/** OpenAI-compatible native tool calls. No reasoning fields are forwarded to the interface. */
export async function streamAgentModel(input: { model:string;baseUrl:string;apiKey:string;messages:AgentMessage[];tools:AgentModelTool[];reasoningEffort?:ReasoningEffort;maxTokens?:number|null;signal:AbortSignal;onText?:(text:string)=>void }): Promise<AgentModelTurn> {
  const firstOutput = new AbortController();
  let timer = setTimeout(()=>firstOutput.abort(new Error('模型长时间没有返回内容或工具参数，请检查连接。')),60_000);
  const activity=()=>{clearTimeout(timer);timer=setTimeout(()=>firstOutput.abort(new Error('模型数据流长时间没有继续返回。')),60_000);};
  const deepseek=isDeepSeek(input.model,input.baseUrl);
  const messages=input.messages.map(message=>{const {reasoning_content,...rest}=message;return deepseek&&message.role==='assistant'?{...rest,reasoning_content:reasoning_content??''}:rest;});
  const body: Record<string,unknown> = { model:input.model,messages,tools:input.tools,tool_choice:'auto',stream:true,parallel_tool_calls:false,...modelReasoning(input.model,input.baseUrl,input.reasoningEffort) };
  if (input.maxTokens) body.max_tokens=input.maxTokens;
  const signal=AbortSignal.any([input.signal,firstOutput.signal,AbortSignal.timeout(10*60_000)]);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try {
    const response=await fetch(`${input.baseUrl.replace(/\/+$/,'')}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${input.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal});
    if(!response.ok){const result=await response.json().catch(()=>({})) as {error?:{message?:string}};throw new Error(result.error?.message||`模型连接返回${response.status}，请检查模型的工具调用支持。`);}
    if(!response.body)throw new Error('模型未返回可读取的数据流。');
    reader=response.body.getReader();
    const decoder=new TextDecoder();
    const calls=new Map<number,{id:string;name:string;arguments:string}>();
    let buffer='',content='',reasoningContent='',finishReason='';
    let sawDone=false;
    const consume=(line:string)=>{
      if(!line.startsWith('data:'))return;
      const raw=line.slice(5).trim();
      if(raw==='[DONE]'){sawDone=true;return;}
      if(!raw)return;
      const payload=JSON.parse(raw) as {error?:{message?:string};choices?:Array<{index?:number;finish_reason?:string;delta?:{content?:string;reasoning_content?:string;tool_calls?:Array<{index:number;id?:string;type?:string;function?:{name?:string;arguments?:string}}>}}>};
      if(payload.error)throw new Error(payload.error.message||'模型中断了本次请求。');
      const choice=payload.choices?.find(item=>item.index===0||item.index===undefined);
      if(choice?.finish_reason)finishReason=choice.finish_reason;
      const delta=choice?.delta;
      if(typeof delta?.reasoning_content==='string'&&delta.reasoning_content){activity();if(deepseek){reasoningContent+=delta.reasoning_content;if(reasoningContent.length>1_500_000)throw new Error('本轮思考内容超过处理上限，已停止；可以缩小任务范围后重试。');}}
      if(typeof delta?.content==='string'&&delta.content){activity();content+=delta.content;if(content.length>200_000)throw new Error('模型回答过长，已停止。');}
      for(const part of delta?.tool_calls??[]){
        activity();
        if(!Number.isInteger(part.index)||part.index<0||part.index>31)throw new Error('工具调用序号无效。');
        const call=calls.get(part.index)??{id:'',name:'',arguments:''};
        if(part.id){if(call.id&&call.id!==part.id)throw new Error('工具调用标识在流中发生变化。');call.id=part.id;}
        if(part.function?.name)call.name+=part.function.name;
        if(part.function?.arguments)call.arguments+=part.function.arguments;
        if(call.arguments.length>150_000)throw new Error('工具参数过长，未执行。');
        calls.set(part.index,call);
      }
    };
    while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});if(buffer.length>1_000_000)throw new Error('模型数据流格式异常。');const lines=buffer.split(/\r?\n/);buffer=lines.pop()??'';for(const line of lines)consume(line);}
    buffer+=decoder.decode();if(buffer.trim())consume(buffer.trim());
    if(!finishReason||(!sawDone&&!['stop','tool_calls'].includes(finishReason)))throw new Error('模型连接提前结束，未执行未完成的调用。');
    if(!['stop','tool_calls'].includes(finishReason))throw new Error('模型输出未完整结束，工具尚未执行；可以继续这项事务。');
    const ids=new Set<string>();
    const toolCalls:AgentToolCall[]=[...calls.entries()].sort(([a],[b])=>a-b).map(([,call])=>{
      if(!call.id||call.id.length>160||ids.has(call.id)||!input.tools.some(tool=>tool.function.name===call.name))throw new Error('模型返回了无效或未开放的工具，未执行。');
      ids.add(call.id);
      let args:unknown;try{args=JSON.parse(call.arguments);}catch{throw new Error('模型工具参数未完整返回，未执行。');}
      if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('工具参数必须是对象。');
      return {id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}};
    });
    if(toolCalls.length&&finishReason!=='tool_calls')throw new Error('工具调用缺少完整的结束信号，未执行。');
    if(!toolCalls.length&&!content.trim())throw new Error('模型没有返回回答或工具调用。');
    // Work narration comes from committed host events. Model preambles for tool turns
    // must not reach speech before the host has validated/executed the actual action.
    if(!toolCalls.length)input.onText?.(content);
    return {content,toolCalls,finishReason,...(deepseek?{reasoningContent}:{})};
  } finally {clearTimeout(timer);await reader?.cancel().catch(()=>{});}
}
