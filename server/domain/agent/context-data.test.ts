import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeAgentContext} from './context-data.js';

test('上下文压缩保持完整 JSON、来源和执行状态',()=>{
  const encoded=encodeAgentContext({memoryRules:'助手旧回答不是事实',memories:Array.from({length:12},(_,id)=>({id:String(id),sourceId:'actual-source',verification:'confirmed',content:'中文长段落'.repeat(6000)})),workContext:{status:'ambiguous',candidates:[{runId:'run',status:'waiting_approval'}]},referencedDocuments:Array.from({length:20},()=>({content:'大文档'.repeat(10000)}))});
  assert.ok(encoded.length<=24000);const value=JSON.parse(encoded);assert.equal(value.contextTruncated,true);assert.equal(value.memoryRules,'助手旧回答不是事实');
  assert.equal(value.workContext.candidates[0].status,'waiting_approval');assert.ok(value.memories.every((item:any)=>item.sourceId==='actual-source'&&item.verification==='confirmed'));
});
test('上下文异常或循环对象不会中断一轮对话',()=>{
  const cyclic:any={historyEvidence:[{role:'assistant',evidenceType:'assistant_statement',content:'旧回答'}]};cyclic.self=cyclic;
  const parsed=JSON.parse(encodeAgentContext(cyclic));assert.equal(parsed.historyEvidence[0].evidenceType,'assistant_statement');assert.equal(parsed.contextTruncated,true);
});
