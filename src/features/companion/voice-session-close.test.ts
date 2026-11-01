import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_VOICE_CONVERSATION_KEY, acknowledgeVoiceSessionClose, closeActiveVoiceConversation, pendingVoiceSessionCloses, persistVoiceConversationStart } from './voice-session-close.js';

function fixture() {
  const values = new Map<string,string>();
  return {
    values,
    store: {
      getItem: (key:string) => values.get(key) ?? null,
      setItem: (key:string,value:string) => {values.set(key,value);},
      removeItem: (key:string) => {values.delete(key);}
    }
  };
}

test('closing preserves a durable outbox until server acknowledgement', () => {
  const {store,values} = fixture();
  values.set(ACTIVE_VOICE_CONVERSATION_KEY,'old');
  const scope = {routingMode:'work' as const,projectId:'project-a',deviceId:'device-a'};
  const payload = closeActiveVoiceConversation(store,scope,'old');
  assert.deepEqual(payload,{conversationId:'old',...scope});
  assert.equal(values.has(ACTIVE_VOICE_CONVERSATION_KEY),false);
  assert.deepEqual(pendingVoiceSessionCloses(store),[payload]);
  values.set(ACTIVE_VOICE_CONVERSATION_KEY,'new');
  assert.equal(closeActiveVoiceConversation(store,scope,'old'),null,'late farewell cannot close a new session');
  assert.equal(values.get(ACTIVE_VOICE_CONVERSATION_KEY),'new');
  acknowledgeVoiceSessionClose(store,'old');
  assert.deepEqual(pendingVoiceSessionCloses(store),[]);
});

test('failed outbox write leaves active conversation available for replay', () => {
  const {store,values} = fixture();
  values.set(ACTIVE_VOICE_CONVERSATION_KEY,'old');
  const failing = {...store,setItem(){throw Error('disk full');}};
  assert.throws(()=>closeActiveVoiceConversation(failing,{routingMode:'life',projectId:null},'old'),/disk full/);
  assert.equal(values.get(ACTIVE_VOICE_CONVERSATION_KEY),'old');
  assert.deepEqual(pendingVoiceSessionCloses(store),[]);
});

test('first-message conversation ID remains closable even when no answer completed', () => {
  const {store,values} = fixture();
  assert.equal(persistVoiceConversationStart(store,'started-id'),'started-id');
  assert.equal(values.get(ACTIVE_VOICE_CONVERSATION_KEY),'started-id');
  assert.throws(()=>persistVoiceConversationStart(store,'different-id',{startedId:'started-id'}),/INVALID_CONVERSATION/);
  const payload = closeActiveVoiceConversation(store,{routingMode:'life',projectId:null,deviceId:'device-a'},'started-id');
  assert.equal(payload?.conversationId,'started-id');
  assert.deepEqual(pendingVoiceSessionCloses(store),[payload]);
});

test('stale active voice ID is rebound only with an explicit server replacement event', () => {
  const {store,values} = fixture();
  values.set(ACTIVE_VOICE_CONVERSATION_KEY,'closed-id');
  assert.throws(()=>persistVoiceConversationStart(store,'fresh-id',{requestedId:'closed-id'}),/INVALID_CONVERSATION/);
  assert.equal(values.get(ACTIVE_VOICE_CONVERSATION_KEY),'closed-id');
  assert.equal(persistVoiceConversationStart(store,'fresh-id',{
    requestedId:'closed-id',replacedConversationId:'closed-id'
  }),'fresh-id');
  assert.equal(values.get(ACTIVE_VOICE_CONVERSATION_KEY),'fresh-id');
  assert.throws(()=>persistVoiceConversationStart(store,'late-id',{
    requestedId:'closed-id',replacedConversationId:'closed-id'
  }),/INVALID_CONVERSATION/);
  assert.equal(values.get(ACTIVE_VOICE_CONVERSATION_KEY),'fresh-id');
});
