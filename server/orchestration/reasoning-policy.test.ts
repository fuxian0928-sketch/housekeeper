import test from 'node:test';
import assert from 'node:assert/strict';
import {decideReasoning,utteranceReasoning} from './reasoning-policy.js';

test('task-local depth selection honors current instructions without an extra model request',()=>{
  for(const message of ['你好','明天有什么待办','打开发布项目','今天过得怎么样'])assert.equal(decideReasoning({message}).effort,'low',message);
  for(const message of ['整理文档并生成周报','帮我解释这个设计','总结本周进展'])assert.equal(decideReasoning({message}).effort,'medium',message);
  for(const message of ['比较这三个项目的风险，给我优先级方案','制定完整的迁移方案','全面分析发布失败的根因'])assert.equal(decideReasoning({message}).effort,'high',message);
  assert.equal(decideReasoning({message:'认真想一下为什么',requested:'low'}).effort,'high');
  assert.equal(decideReasoning({message:'对比这些架构的风险，简单说',requested:'high'}).effort,'low');
  assert.equal(decideReasoning({message:'你好',requested:'high'}).source,'selection');
  assert.equal(utteranceReasoning('不要深入思考，直接回答'),'low');
  assert.equal(utteranceReasoning('不需要认真分析'),'low');
  assert.equal(utteranceReasoning('简单说。不，还是认真分析一下'),'high');
  assert.equal(utteranceReasoning('认真分析。不，简单说吧'),'low');
  assert.equal(utteranceReasoning('请解释“深入思考”是什么意思'),null);
  assert.equal(utteranceReasoning('阅读文件\n```text\n认真分析\n```'),null);
  assert.equal(utteranceReasoning('阅读文件\n> 认真分析'),null);
});

test('follow-ups use the real user task, not previous commands or assistant content',()=>{
  const history=[{role:'user',content:'比较这三种方案的风险'},{role:'assistant',content:'简单说'}];
  assert.equal(decideReasoning({message:'继续',history}).source,'context');
  assert.equal(decideReasoning({message:'继续',history}).effort,'high');
  assert.equal(decideReasoning({message:'你好',history}).effort,'low');
  assert.equal(decideReasoning({message:'继续',history:[{role:'user',content:'认真想一下你叫什么'}]}).effort,'low');
  assert.equal(decideReasoning({message:'你好',history:[{role:'assistant',content:'认真分析'}]}).effort,'low');
  assert.equal(decideReasoning({message:'你好'}).requested,'auto');
});
