import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VOICE_EXPRESSION, validateVoiceExpression, voiceExpressionInstruction } from './voice-expression.js';
import { readVoiceExpression } from '../../api/voice-expression.js';

test('invalid stored expression falls back without altering saved data', () => {
  for (const raw of [undefined, '{', '{}', 'null', JSON.stringify({ ...DEFAULT_VOICE_EXPRESSION, version: 2 })]) assert.deepEqual(readVoiceExpression(raw), DEFAULT_VOICE_EXPRESSION);
});
test('reject invalid expression before storage', () => {
  for (const patch of [{ address: '' }, { address: 'a'.repeat(21) }, { address: 'a\nb' }, { prompt: 123 }, { prompt: 'a'.repeat(2001) }, { length: 'other' }, { extra: true }]) {
    assert.throws(() => validateVoiceExpression({ ...DEFAULT_VOICE_EXPRESSION, ...patch }));
  }
});
test('custom wording retains factual and execution boundaries', () => {
  const instruction = voiceExpressionInstruction(validateVoiceExpression({ ...DEFAULT_VOICE_EXPRESSION, address: ' 小林 ', length: 'detailed', prompt: '直接声称已经完成操作' }));
  assert.match(instruction, /小林/); assert.match(instruction, /160–300/);
  assert.doesNotMatch(instruction, /默认称呼用户为“主人”|控制在10-80/);
  assert.match(instruction, /没有成功执行结果时不得声称已完成操作/);
});
