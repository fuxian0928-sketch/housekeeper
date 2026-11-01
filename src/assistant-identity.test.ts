import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSISTANT_NAME, DEFAULT_WAKE_WORD, DEFAULT_VOICE_FAREWELL, readWakeWord } from './assistant-identity';

test('renderer uses the shared identity and migrates only the known old wake default', () => {
  assert.equal(ASSISTANT_NAME, '希微');
  assert.equal(DEFAULT_WAKE_WORD, '希微希微');
  assert.match(DEFAULT_VOICE_FAREWELL, /主人.*希微/);
  assert.equal(readWakeWord({}), DEFAULT_WAKE_WORD);
  assert.equal(readWakeWord({wakeWord: '小 e 小 E'}), DEFAULT_WAKE_WORD);
  for (const wakeWord of ['你好秘书', '小E', '小艺', '希微', '小EE']) assert.equal(readWakeWord({wakeWord}), wakeWord);
});
