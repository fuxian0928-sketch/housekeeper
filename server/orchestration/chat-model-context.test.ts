import test from 'node:test';
import assert from 'node:assert/strict';
import { chatModelContext, selectedChatModel } from './chat-model-context.js';

test('model overrides stay isolated across concurrent asynchronous chats', async () => {
  const results = await Promise.all(['model-a', 'model-b'].map(model => chatModelContext.run(model, async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return selectedChatModel('default');
  })));
  assert.deepEqual(results, ['model-a', 'model-b']);
  assert.equal(selectedChatModel('default'), 'default');
});

test('background memory work uses the default model outside the chat context', async () => {
  await chatModelContext.run('chat-only', async () => {
    await chatModelContext.exit(async () => {
      await Promise.resolve();
      assert.equal(selectedChatModel('memory-default'), 'memory-default');
    });
    assert.equal(selectedChatModel('default'), 'chat-only');
  });
});
