import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsWakeTranscript } from './voice-wake-transcript.js';

test('wake transcript confirms a short or repeated address at the start', () => {
  for (const configured of ['希微', '希微希微', '小E', '小E小E']) {
    for (const heard of ['希微', '希微希微，请说', '嗯，希微帮我看看', '小E', '小E小E，请说', '小艺帮我看看', '嗯，小易小易', '小伊。']) {
      assert.equal(acceptsWakeTranscript(heard, configured), true, `${configured}: ${heard}`);
    }
  }
});

test('ordinary speech and a later mention do not confirm an acoustic wake', () => {
  for (const heard of ['', '今天工作忙吗', '帮我找小E', '帮我找希微', '小王，帮我看看', '嗯，我在打字', '细微差别', '细微变化', '西微波炉', '曦微光照', '我说西微', '希望你帮我']) {
    assert.equal(acceptsWakeTranscript(heard, '希微希微'), false, heard);
  }
  assert.equal(acceptsWakeTranscript('小明，帮我看看', '小明'), true);
  assert.equal(acceptsWakeTranscript('我叫小明', '小明'), false);
});

test('near-name ASR forms require an opening direct address and never affect custom phrases', () => {
  for (const heard of ['西微', '曦微曦微', '嗯，西微，请帮我看看', '曦微帮我整理', '西微你在吗', '西威西威你好', '细微，你在吗', '稀微稀微，请说', '希维帮我整理', '希薇']) assert.equal(acceptsWakeTranscript(heard, '希微希微'), true, heard);
  for (const heard of ['希微', '小E', '西微']) assert.equal(acceptsWakeTranscript(heard, '你好秘书'), false, heard);
  assert.equal(acceptsWakeTranscript('你好秘书，请说', '你好秘书'), true);
});

test('local ASR homophones do not admit ordinary words, later mentions or custom wake phrases', () => {
  for (const heard of ['细微差别', '细微变化', '细微的变化', '西威胁迫', '稀微光线', '西维度量', '我说西威西威你好', '请帮我找西威', '为什么叫希维']) {
    assert.equal(acceptsWakeTranscript(heard, '小E'), false, heard);
  }
  for (const configured of ['小E', '小E小E', '希微', '希微希微']) {
    assert.equal(acceptsWakeTranscript('西威西威你好', configured), true, configured);
    assert.equal(acceptsWakeTranscript('戚薇西威你好', configured), true, configured);
  }
  assert.equal(acceptsWakeTranscript('西威西威你好', '你好秘书'), false);
  for (const heard of ['戚薇', '戚薇你好', '戚薇的新电影', '我是西威', '我说戚薇西威你好', '戚薇与西威你好']) assert.equal(acceptsWakeTranscript(heard, '小E'), false, heard);
});
