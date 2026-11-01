import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantIdentityReply, BASE_ASSISTANT_PROMPT, CHAT_ASSISTANT_PROMPT, VOICE_ASSISTANT_PROMPT } from './prompts.js';

test('希微身份在工作、聊天与语音提示词中保持一致且保留主人称呼', () => {
  for (const prompt of [BASE_ASSISTANT_PROMPT, CHAT_ASSISTANT_PROMPT, VOICE_ASSISTANT_PROMPT]) {
    assert.match(prompt, /名字是“希微”/);
    assert.match(prompt, /称呼用户为“主人”/);
    assert.doesNotMatch(prompt, /小\s*e/i);
  }
});

test('聊天与复杂工作使用不同的回答长度策略', () => {
  assert.match(CHAT_ASSISTANT_PROMPT, /聊天类回答可以适度简洁/);
  assert.match(BASE_ASSISTANT_PROMPT, /回答长度必须跟随任务复杂度/);
  assert.match(BASE_ASSISTANT_PROMPT, /复杂的工作分析、方案设计、项目规划、技术排查、复盘和决策问题必须充分展开/);
  assert.match(BASE_ASSISTANT_PROMPT, /候选方案比较、执行步骤、依赖、风险、验证方法或必要示例/);
});

test('身份问题直接回答且不需要模型或 RAG', () => {
  for (const text of ['你叫什么', '希微是你吗', '希微叫什么', '你不是应该叫小E吗', '小 E是你吗', '小e是谁']) {
    assert.match(assistantIdentityReply(text) ?? '', /主人.*希微.*私人 AI 秘书/, text);
    assert.doesNotMatch(assistantIdentityReply(text) ?? '', /小\s*e/i);
  }
  assert.equal(assistantIdentityReply('总结当前项目进展'), null);
});
