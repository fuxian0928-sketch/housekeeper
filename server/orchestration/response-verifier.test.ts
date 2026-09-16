import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAnswerSupport } from './response-verifier.js';

test('能够识别由引用内容支持的事实', () => {
  const result = verifyAnswerSupport('当前版本只实现工作相关意图。', [{ document: '意图识别', path: 'AI秘书/意图.md', excerpt: '当前版本只实现工作相关意图，生活相关暂缓。' }]);
  assert.equal(result.status, 'supported');
  assert.equal(result.supportedStatementCount, 1);
});

test('能够标记引用中不存在的事实', () => {
  const result = verifyAnswerSupport('项目已经在上海发布正式版本。', [{ document: '技术方案', path: '技术.md', excerpt: '本地客户端使用 SQLite。' }]);
  assert.equal(result.status, 'partial');
  assert.equal(result.unsupportedStatements.length, 1);
});
