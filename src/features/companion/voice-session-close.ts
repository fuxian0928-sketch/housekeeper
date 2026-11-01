export type VoiceSessionClose = {
  conversationId: string;
  routingMode: 'life' | 'work' | 'auto';
  projectId: string | null;
  deviceId?: string;
};

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const ACTIVE_VOICE_CONVERSATION_KEY = 'ai-secretary-companion-voice-conversation-id';
const PENDING_KEY = 'ai-secretary-companion-voice-pending-closes';

export function persistVoiceConversationStart(store: Store, conversationId: unknown, options: {
  requestedId?: string | null;
  replacedConversationId?: unknown;
  startedId?: string | null;
} = {}): string {
  const requestedId = options.requestedId ?? null;
  const activeId = store.getItem(ACTIVE_VOICE_CONVERSATION_KEY);
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 200 ||
    (options.startedId
      ? conversationId !== options.startedId || activeId !== options.startedId
      : activeId !== requestedId ||
        (options.replacedConversationId === undefined
          ? Boolean(requestedId && conversationId !== requestedId)
          : !requestedId || options.replacedConversationId !== requestedId || conversationId === requestedId))) throw Error('VOICE_CHAT_INVALID_CONVERSATION');
  store.setItem(ACTIVE_VOICE_CONVERSATION_KEY, conversationId);
  return conversationId;
}

export function pendingVoiceSessionCloses(store: Store): VoiceSessionClose[] {
  const raw = store.getItem(PENDING_KEY);
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw Error('VOICE_SESSION_OUTBOX_INVALID'); }
  if (!Array.isArray(value) || value.length > 100 || value.some(item => !item || typeof item !== 'object' ||
    typeof item.conversationId !== 'string' || !item.conversationId || item.conversationId.length > 200 ||
    !['life', 'work', 'auto'].includes(item.routingMode) ||
    (item.projectId !== null && typeof item.projectId !== 'string') ||
    (item.deviceId !== undefined && typeof item.deviceId !== 'string'))) throw Error('VOICE_SESSION_OUTBOX_INVALID');
  return value as VoiceSessionClose[];
}

export function closeActiveVoiceConversation(store: Store, scope: Omit<VoiceSessionClose, 'conversationId'>, expectedId?: string | null): VoiceSessionClose | null {
  const conversationId = store.getItem(ACTIVE_VOICE_CONVERSATION_KEY);
  if (!conversationId || (expectedId !== undefined && expectedId !== conversationId)) return null;
  const pending = pendingVoiceSessionCloses(store);
  const payload = pending.find(item => item.conversationId === conversationId) ?? { conversationId, ...scope };
  if (!pending.some(item => item.conversationId === conversationId)) {
    if (pending.length >= 100) throw Error('VOICE_SESSION_OUTBOX_FULL');
    // Persist the handoff before removing the active pointer. If this write fails,
    // the old pointer remains for a safe retry on the next launch.
    store.setItem(PENDING_KEY, JSON.stringify([...pending, payload]));
  }
  store.removeItem(ACTIVE_VOICE_CONVERSATION_KEY);
  return payload;
}

export function acknowledgeVoiceSessionClose(store: Store, conversationId: string) {
  const pending = pendingVoiceSessionCloses(store);
  const next = pending.filter(item => item.conversationId !== conversationId);
  if (next.length === pending.length) return;
  if (next.length) store.setItem(PENDING_KEY, JSON.stringify(next));
  else store.removeItem(PENDING_KEY);
}
