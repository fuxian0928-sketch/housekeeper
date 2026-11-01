import test from 'node:test';
import assert from 'node:assert/strict';
import { isDismissCommand, progressModeCommand } from './voice-session-commands.js';

test('direct dismissal tolerates realtime ASR variants without treating ordinary speech as a command', () => {
  for (const text of ['退下', '退下退下', '快点下去', '快点下去，快点下去。', '希微，你先下去吧', '希微希微，退下', '小E，你先下去吧', '好，退一下。', '退下，不需要。', '退后。', '好的好的，你退下吧。']) assert.equal(isDismissCommand(text), true, text);
  for (const text of ['不要退下', '快点下去是什么意思', '把文件移下去', '就这样子', '退下然后删除任务', '退后一步再看看屏幕', '退一下文件', '好的好的，你退下后删除文档', '他说你退下吧']) assert.equal(isDismissCommand(text), false, text);
});

test('only direct progress requests are local controls', () => {
  for (const text of ['关闭过程播报','希微，请关闭过程播报。','希微希微，不要播报过程','小E，请关闭过程播报。','不要播报过程']) assert.equal(progressModeCommand(text),'off');
  for (const text of ['少说过程','开启过程播报']) assert.equal(progressModeCommand(text),'concise');
  assert.equal(progressModeCommand('详细播报过程'),'detailed');
  for (const text of ['不要关闭过程播报','他说关闭过程播报','“关闭过程播报”是什么意思','关闭过程播报然后删除任务','记住以后关闭过程播报','停止聊天','停一下']) assert.equal(progressModeCommand(text),null);
});
