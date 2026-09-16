import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantIdentityReply, BASE_ASSISTANT_PROMPT, CHAT_ASSISTANT_PROMPT } from './prompts.js';

test('小 E 身份在工作与聊天提示词中保持一致', () => {
  for (const prompt of [BASE_ASSISTANT_PROMPT, CHAT_ASSISTANT_PROMPT]) {
    assert.match(prompt, /名字是“小 E”/);
    assert.match(prompt, /称呼用户为“主人”/);
  }
});

test('聊天与复杂工作使用不同的回答长度策略', () => {
  assert.match(CHAT_ASSISTANT_PROMPT, /聊天类回答可以适度简洁/);
  assert.match(BASE_ASSISTANT_PROMPT, /回答长度必须跟随任务复杂度/);
  assert.match(BASE_ASSISTANT_PROMPT, /复杂的工作分析、方案设计、项目规划、技术排查、复盘和决策问题必须充分展开/);
  assert.match(BASE_ASSISTANT_PROMPT, /候选方案比较、执行步骤、依赖、风险、验证方法或必要示例/);
});

test('身份问题直接回答且不需要模型或 RAG', () => {
  assert.match(assistantIdentityReply('你叫什么') ?? '', /主人.*小 E.*私人 AI 秘书/);
  assert.match(assistantIdentityReply('你不是应该叫小E吗') ?? '', /主人.*小 E/);
  assert.equal(assistantIdentityReply('总结当前项目进展'), null);
});
