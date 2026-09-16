import { AsyncLocalStorage } from 'node:async_hooks';

// Request-local selection must never mutate global settings or another chat.
export const chatModelContext = new AsyncLocalStorage<string>();
export function selectedChatModel(defaultModel: string) {
  return chatModelContext.getStore() || defaultModel;
}
