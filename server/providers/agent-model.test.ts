import assert from 'node:assert/strict';
import test from 'node:test';
import { streamAgentModel } from './agent-model.js';

test('native model streams complete tool calls and rejects incomplete effects',async context=>{
  const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original;});
  const run=()=>streamAgentModel({model:'test',baseUrl:'https://model.invalid/v1',apiKey:'test-only',messages:[{role:'user',content:'创建待办'}],tools:[{type:'function',function:{name:'create_task',description:'创建待办',parameters:{type:'object'}}}],signal:new AbortController().signal});
  const chunks=(values:unknown[])=>values.map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n';
  const response=(text:string)=>{const bytes=new TextEncoder().encode(text);return new Response(new ReadableStream({start(controller){for(let n=0;n<bytes.length;n+=7)controller.enqueue(bytes.slice(n,n+7));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});};
  const parts=[{choices:[{index:0,delta:{tool_calls:[{index:0,id:'task-1',function:{name:'create_task',arguments:'{"title":"'}}]}}]},{choices:[{index:0,delta:{reasoning_content:'hidden',tool_calls:[{index:0,function:{arguments:'整理周报"}'}}]},finish_reason:'tool_calls'}]}];
  await context.test('fragments including split UTF-8 form one callable receipt',async()=>{globalThis.fetch=async(_url,options)=>{const body=JSON.parse(String(options?.body));assert.equal(body.parallel_tool_calls,false);return response(chunks(parts));};const result=await run();assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments),{title:'整理周报'});assert.equal(result.content,'');});
  await context.test('truncation and malformed arguments never produce callable output',async()=>{globalThis.fetch=async()=>response(chunks([{choices:[{index:0,delta:{tool_calls:[{index:0,id:'partial',function:{name:'create_task',arguments:'{"title":'}}]},finish_reason:'length'}]}]));await assert.rejects(run,/未完整结束/);});
  await context.test('unexposed function is rejected before any host operation',async()=>{globalThis.fetch=async()=>response(chunks([{choices:[{index:0,delta:{tool_calls:[{index:0,id:'invalid',function:{name:'shell_exec',arguments:'{}'}}]},finish_reason:'tool_calls'}]}]));await assert.rejects(run,/未开放/);});
});
