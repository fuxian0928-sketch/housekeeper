import assert from 'node:assert/strict';
import test from 'node:test';
import { lexicalSimilarity } from './memory-service.js';

test('相同含义的中文记忆具有较高词法相似度', () => {
  const score = lexicalSimilarity('当前版本只实现工作相关意图', '当前版本仅实现工作相关的意图识别');
  assert.ok(score >= 0.45, `相似度过低：${score}`);
});

test('无关记忆不会被判为重复', () => {
  const score = lexicalSimilarity('Obsidian 文档写入必须二次确认', '项目首页需要显示高优先级任务');
  assert.ok(score < 0.3, `相似度过高：${score}`);
});
