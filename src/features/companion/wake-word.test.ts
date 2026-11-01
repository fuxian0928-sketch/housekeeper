import assert from 'node:assert/strict';
import test from 'node:test';
import { wakeWordScore } from './wake-word';

test('phonetic matching handles the real microphone transcript and homophones', () => {
  for (const text of ['小E小E', '小艺小。', '小易啊', '小衣小衣', '小姨你好']) assert.equal(wakeWordScore(text, '小E小E'), 1, text);
  for (const text of ['', '小王', '今天工作忙吗', '帮我找小艺']) assert.equal(wakeWordScore(text, '小E小E'), 0, text);
  assert.equal(wakeWordScore('晓明啊', '小明'), 1);
  assert.equal(wakeWordScore('小艺', '小明'), 0);
});

test('new default accepts the direct name and old addresses without matching ordinary homophones', () => {
  for (const text of ['希微', '希微希微', '希微，帮我看看', '西微，请帮我看看', '曦微曦微', '小E', '小E小E']) assert.equal(wakeWordScore(text, '希微希微'), 1, text);
  for (const text of ['细微差别', '细微变化', '希望你帮我', '帮我找希微', '这是什么西微波炉', '西微波炉', '曦微光照']) assert.equal(wakeWordScore(text, '希微希微'), 0, text);
  assert.equal(wakeWordScore('希微', '你好秘书'), 0);
});
