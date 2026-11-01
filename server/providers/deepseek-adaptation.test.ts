import assert from 'node:assert/strict';
import test from 'node:test';
import {modelReasoning,isDeepSeek} from './model-reasoning.js';
import {OpenAICompatibleLlmProvider} from './llm-provider.js';
import {streamAgentModel} from './agent-model.js';
import type {AgentMessage} from '../domain/agent/types.js';

const response=(events:unknown[])=>new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')+'data: [DONE]\n\n');
test('provider mapping explicitly separates fast, standard and deep requests',()=>{
  assert.equal(isDeepSeek('vendor/deepseek-flash','https://relay.invalid/v1'),true);
  assert.equal(isDeepSeek('alias','https://api.deepseek.com/v1'),true);
  assert.deepEqual(modelReasoning('deepseek-flash','https://relay.invalid/v1','low'),{thinking:{type:'disabled'}});
  assert.deepEqual(modelReasoning('deepseek-flash','https://relay.invalid/v1','medium'),{thinking:{type:'enabled'},reasoning_effort:'low'});
  assert.deepEqual(modelReasoning('deepseek-flash','https://relay.invalid/v1','high'),{thinking:{type:'enabled'},reasoning_effort:'high'});
  assert.deepEqual(modelReasoning('deepseek-flash','https://relay.invalid/v1','auto'),{thinking:{type:'disabled'}});
  assert.deepEqual(modelReasoning('qwen3.7-flash','https://relay.invalid/v1','low'),{enable_thinking:false});
  assert.deepEqual(modelReasoning('other','https://relay.invalid/v1','high'),{reasoning_effort:'high'});
});

test('text/vision calls use provider thinking controls and never emit reasoning to speech',async context=>{
  const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original;});
  const bodies:any[]=[];
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);return body.stream?response([{choices:[{delta:{reasoning_content:'PRIVATE_REASONING'}}]},{choices:[{delta:{content:'可以。'},finish_reason:'stop'}]}]):new Response(JSON.stringify({choices:[{message:{reasoning_content:'PRIVATE_REASONING',content:'可以。'}}]}));};
  const provider=new OpenAICompatibleLlmProvider('deepseek-flash','https://api.deepseek.com','test-only');
  await provider.complete('测试',{instruction:'测试',reasoningEffort:'low'});
  assert.equal(bodies[0].thinking.type,'disabled');assert.equal(bodies[0].reasoning_effort,undefined);
  const spoken:string[]=[];
  assert.equal(await provider.stream('认真想一下',value=>spoken.push(value),{instruction:'测试',reasoningEffort:'high'}),'可以。');
  assert.deepEqual(spoken,['可以。']);assert.equal(bodies[1].thinking.type,'enabled');
  await provider.completeWithImage('看图','data:image/png;base64,AA==',{instruction:'测试',reasoningEffort:'low'});
  assert.equal(bodies[2].thinking.type,'disabled');assert.equal(bodies[2].messages[1].content[1].type,'image_url');
});

test('DeepSeek agent preserves split reasoning and native tool pairs across repeated calls',async context=>{
  const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original;});
  let round=0;const sent:any[]=[];
  globalThis.fetch=async(_url,init)=>{
    sent.push(JSON.parse(String(init?.body)));round++;
    return round===1?response([{choices:[{delta:{reasoning_content:'PRIVATE_'}}]},{choices:[{delta:{reasoning_content:'REASONING',tool_calls:[{index:0,id:'c1',function:{name:'get_document',arguments:'{"id":"one"}'}}]},finish_reason:'tool_calls'}]}]):response([{choices:[{delta:{reasoning_content:'SECOND_PRIVATE',content:'已核对。'},finish_reason:'stop'}]}]);
  };
  const messages:AgentMessage[]=[{role:'user',content:'认真分析文档'}],tools=[{type:'function' as const,function:{name:'get_document',description:'读取',parameters:{type:'object'}}}];
  const spoken:string[]=[];
  const call=()=>streamAgentModel({model:'deepseek-flash',baseUrl:'https://api.deepseek.com',apiKey:'test-only',messages,tools,reasoningEffort:'high',signal:new AbortController().signal,onText:value=>spoken.push(value)});
  const first=await call();assert.equal(first.reasoningContent,'PRIVATE_REASONING');assert.deepEqual(spoken,[]);
  messages.push({role:'assistant',content:null,tool_calls:first.toolCalls,reasoning_content:first.reasoningContent},{role:'tool',content:'原文',tool_call_id:'c1'});
  const second=await call();assert.equal(second.content,'已核对。');assert.deepEqual(spoken,['已核对。']);
  assert.equal(sent[1].messages[1].reasoning_content,'PRIVATE_REASONING');assert.equal(sent[1].messages[2].tool_call_id,'c1');
  assert.equal(sent[1].thinking.type,'enabled');
  globalThis.fetch=async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return response([{choices:[{delta:{content:'完成。'},finish_reason:'stop'}]}]);};
  await streamAgentModel({model:'other',baseUrl:'https://other.invalid/v1',apiKey:'test-only',messages,tools,reasoningEffort:'low',signal:new AbortController().signal});
  assert.ok(sent.at(-1).messages.every((message:any)=>!('reasoning_content' in message)));
});
