import assert from 'node:assert/strict';
import test from 'node:test';
import { wakeWordScore } from './wake-word';

test('phonetic matching handles the real microphone transcript and homophones', () => {
  for (const text of ['小E小E', '小艺小。', '小易啊', '小衣小衣', '小姨你好']) assert.equal(wakeWordScore(text, '小E小E'), 1, text);
  for (const text of ['', '小王', '今天工作忙吗', '帮我找小艺']) assert.equal(wakeWordScore(text, '小E小E'), 0, text);
  assert.equal(wakeWordScore('晓明啊', '小明'), 1);
  assert.equal(wakeWordScore('小艺', '小明'), 0);
});
