import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createNativeSharedChat } from './native-shared-chat.js';
const context = () => ({ key: { workerGeneration: 1, audioGeneration: 1, turn: 1 }, text: '帮我处理任务', signal: new AbortController().signal, requestStandby: () => true, beginPlayback: () => true });

test('dual presentation speaks narration only and never marks the original as fully read',async()=>{
 const original='## 完整原文\n**预算30万元**（待核实），原文保留在页面。',narration='预算是30万元，不过还需要核实。';let bound=0,body:any;
 const answer=createNativeSharedChat({baseUrl:'http://localhost:1',voicePresentation:true,settings:()=>({routingMode:'auto'}),onConversation(){},onAnswer(){bound++;},fetch:(async(_u,init)=>{
  body=JSON.parse(String(init?.body));return new Response([{type:'delta',delta:original},{type:'done',answer:original,narration,voicePresentation:'dual-v1',conversationId:'voice',assistantMessageId:'message'}].map(e=>JSON.stringify(e)).join('\n'));
 }) as typeof fetch});
 let result='';for await(const value of answer(context()))result+=value;
 assert.equal(body.voicePresentation,'dual-v1');assert.equal(result,narration);assert.equal(bound,0);assert.ok(original.includes('**'));
});

test('older server falls back to a speech projection without reading Markdown or URLs',async()=>{
 const answer=createNativeSharedChat({baseUrl:'http://localhost:1',voicePresentation:true,settings:()=>({routingMode:'life'}),onConversation(){},fetch:(async()=>new Response(JSON.stringify({type:'done',answer:'## 进展\n**预算30万元**（待核实）。查看[原文](https://example.com)。',conversationId:'v'}))) as typeof fetch});
 let text='';for await(const value of answer(context()))text+=value;
 assert.doesNotMatch(text,/[#*()（）]|https/);assert.match(text,/预算30万元，待核实。/);assert.match(text,/原文/);
});

test('a missing summary does not silently become a long report reading',async()=>{
 let bound=0;
 const answer=createNativeSharedChat({baseUrl:'http://localhost:1',voicePresentation:true,settings:()=>({routingMode:'auto'}),onConversation(){},onAnswer(){bound++;},fetch:(async()=>new Response(JSON.stringify({type:'done',answer:'完整报告。'.repeat(150),conversationId:'v',assistantMessageId:'m'}))) as typeof fetch});
 let text='';for await(const value of answer(context()))text+=value;
 assert.equal(text,'完整内容已保留在页面，口播摘要暂未可靠生成，请查看原文。');
 assert.equal(bound,0,'a summary or fallback is never a receipt for reading the original');
});
test('native voice captures one camera snapshot only for an explicit scene question',async()=>{
  let captures=0;const bodies:any[]=[];
  const answer=createNativeSharedChat({baseUrl:'http://127.0.0.1',settings:()=>({routingMode:'auto'}),onConversation(){},captureCameraFrame:async()=>{captures++;return 'data:image/jpeg;base64,YQ==';},fetch:(async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({type:'done',answer:'收到。',conversationId:'camera-test'}));}) as typeof fetch});
  for(const text of ['你好','你能看见我手里拿的是什么吗'])for await(const _ of answer({...context(),text})){}
  assert.equal(captures,1);assert.equal(bodies[0].cameraFrame,undefined);assert.equal(bodies[1].cameraFrame,'data:image/jpeg;base64,YQ==');
});
test('auto voice reaches Agent and dispatches page/activity events without speaking them',async()=>{
  const navigation={id:'navigation-one',token:'opaque-receipt',target:{kind:'project',id:'p1',title:'项目一'}},shown:unknown[]=[],activity:unknown[]=[];let body:any;
  const answer=createNativeSharedChat({baseUrl:'http://127.0.0.1:43110',settings:()=>({routingMode:'auto',deviceId:'device-one'}),onConversation(){},onNavigation:event=>shown.push(event),onActivity:event=>activity.push(event),fetch:(async(_url,options)=>{body=JSON.parse(options!.body as string);return new Response([{type:'conversation-started',conversationId:'voice-one'},{type:'agent-run',conversationId:'voice-one',runId:'run-one'},{type:'run-event',event:{type:'navigation_requested',detail:navigation}},{type:'done',answer:'已显示项目一。',conversationId:'voice-one',runId:'run-one'}].map(event=>JSON.stringify(event)).join('\n'));}) as typeof fetch});
  let spoken='';for await(const delta of answer(context()))spoken+=delta;
  assert.equal(body.agentRuntime,true);assert.equal(spoken,'已显示项目一。');assert.deepEqual(shown,[navigation]);assert.equal(activity.length,2);
});
test('per-turn work/life switch retains history and only exposes answer text', async () => {
  let mode: 'work' | 'life' = 'work', history: string | null = null;
  const bodies: any[] = [];
  const answer = createNativeSharedChat({ baseUrl: 'http://127.0.0.1:43110', settings: () => ({ routingMode: mode, projectId: 'project-a', conversationId: history }), onConversation: id => { history = id; },
    fetch: (async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      const encoded = Buffer.from([{ type: 'progress', message: 'private-plan' }, { type: 'citations', citations: ['private-document'] }, { type: 'delta', delta: '已收到。' }, { type: 'done', answer: '已收到。请稍候。', conversationId: 'voice-history' }].map(e => JSON.stringify(e)).join('\n'));
      return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.subarray(i, i + 7)); controller.close(); } }));
    }) as typeof fetch });
  for (const next of ['work', 'life'] as const) { mode = next; let text = ''; for await (const delta of answer(context())) text += delta; assert.equal(text, '已收到。请稍候。'); }
  assert.equal(bodies[0].projectId, 'project-a'); assert.equal(bodies[0].scope, 'project');
  assert.equal(bodies[1].projectId, null); assert.equal(bodies[1].scope, 'memory'); assert.equal(bodies[1].conversationId, 'voice-history');
  assert.ok(bodies.every(body => body.interactionMode === 'voice'));
});
test('voice answer selection reaches the real chat request and follow mode omits overrides', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let separate = true;
  const answer = createNativeSharedChat({ baseUrl: 'http://127.0.0.1:43110',
    settings: () => ({ routingMode: 'life', voiceChatModel: separate ? 'voice-model' : '', voiceReasoningEffort: separate ? 'low' : 'follow' }),
    onConversation() {},
    fetch: (async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return new Response(JSON.stringify({ type: 'done', answer: '收到。', conversationId: 'voice-id' }));
    }) as typeof fetch });
  for (const mode of [true, false]) {
    separate = mode;
    for await (const _ of answer(context())) { /* drain */ }
  }
  assert.equal(bodies[0].model, 'voice-model');
  assert.equal(bodies[0].reasoningEffort, 'low');
  assert.equal(bodies[1].model, undefined);
  assert.equal(bodies[1].reasoningEffort, undefined);
});
test('truncation, provider error and inconsistent final are not successful answers', async () => {
  for (const events of [[], [{ type: 'error', message: 'secret' }], [{ type: 'delta', delta: '一' }, { type: 'done', answer: '二', conversationId: 'x' }]]) {
    let saved = false;
    const answer = createNativeSharedChat({ baseUrl: 'http://localhost:1', settings: () => ({ routingMode: 'auto' }), onConversation: () => { saved = true; }, fetch: (async () => new Response(events.map(e => JSON.stringify(e)).join('\n'))) as typeof fetch });
    await assert.rejects(async () => { for await (const _ of answer(context())) {} }, /VOICE_CHAT_/); assert.equal(saved, false);
  }
});
test('new voice conversation is persisted as soon as the first user message exists, even if the answer fails', async () => {
  const saved: string[] = [];
  const answer = createNativeSharedChat({ baseUrl: 'http://localhost:1', settings: () => ({ routingMode: 'work', conversationId: null }),
    onConversation: id => { saved.push(id); },
    fetch: (async () => new Response([
      {type:'conversation-started',conversationId:'new-voice-session',createdAt:'2026-09-24T00:00:00.000Z'},
      {type:'error',message:'answer failed'}
    ].map(event => JSON.stringify(event)).join('\n'))) as typeof fetch });
  await assert.rejects(async () => { for await (const _ of answer(context())) {} }, /VOICE_CHAT_FAILED/);
  assert.deepEqual(saved,['new-voice-session']);
});
test('stale voice conversation ID is rebound only when the server names the replaced ID', async () => {
  for (const replacedConversationId of [undefined,'closed-id']) {
    let activeId = 'closed-id';
    const answer = createNativeSharedChat({ baseUrl: 'http://localhost:1', settings: () => ({ routingMode: 'life', conversationId: activeId }),
      onConversation: id => { activeId = id; },
      fetch: (async () => new Response([
        {type:'conversation-started',conversationId:'fresh-id',replacedConversationId},
        {type:'done',answer:'新的会话。',conversationId:'fresh-id'}
      ].map(event => JSON.stringify(event)).join('\n'))) as typeof fetch });
    if (replacedConversationId === undefined) {
      await assert.rejects(async () => { for await (const _ of answer(context())) {} }, /VOICE_CHAT_INVALID_CONVERSATION/);
      assert.equal(activeId,'closed-id');
    } else {
      let spoken = ''; for await (const text of answer(context())) spoken += text;
      assert.equal(spoken,'新的会话。');
      assert.equal(activeId,'fresh-id');
    }
  }
});
test('aborted request cannot start or mutate conversation history', async () => {
  let called = false; const controller = new AbortController(); controller.abort();
  const answer = createNativeSharedChat({ baseUrl: 'http://127.0.0.1', settings: () => ({ routingMode: 'life' }), onConversation: () => { called = true; }, fetch: (async () => { called = true; return new Response(); }) as typeof fetch });
  await assert.rejects(answer({ ...context(), signal: controller.signal })[Symbol.asyncIterator]().next()); assert.equal(called, false);
  assert.throws(() => createNativeSharedChat({ baseUrl: 'https://example.com', settings: () => ({ routingMode: 'life' }), onConversation() {} }), /INVALID_LOCAL_SERVICE/);
});

test('abort during real HTTP response closes the connection and never saves late history', { timeout: 5000 }, async () => {
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const server = createServer((request, response) => {
    request.resume(); response.on('close', resolveClosed);
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(JSON.stringify({ type: 'delta', delta: '正在处理。' }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const controller = new AbortController(); let saved = false;
  const answer = createNativeSharedChat({ baseUrl: `http://127.0.0.1:${address.port}`, settings: () => ({ routingMode: 'work' }), onConversation: () => { saved = true; } });
  try {
    const iterator = answer({ ...context(), signal: controller.signal })[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value, '正在处理。');
    const waiting = iterator.next(); controller.abort();
    await assert.rejects(waiting); await closed; assert.equal(saved, false);
  } finally { controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('typed progress is separate from answer and drops duplicate, expired or other-turn events', async () => {
  const now=Date.now(), seen:any[]=[];
  const progress={type:'voice-progress',eventId:'t:1',sessionId:'s',turnId:'t',sequence:1,operationId:'retrieve',planRevision:1,configRevision:1,stage:'retrieval',status:'running',occurredAt:now,expiresAt:now+5000};
  const events=[progress,progress,{...progress,sequence:2,turnId:'other'},{...progress,sequence:3,expiresAt:now-1},
    {...progress,eventId:'t:4',sequence:4,status:'succeeded',text:'secret-document'},
    {type:'done',answer:'查好了。',conversationId:'s'}];
  const answer=createNativeSharedChat({baseUrl:'http://127.0.0.1',settings:()=>({routingMode:'work'}),onConversation(){},onProgress:e=>seen.push(e),
    fetch:(async()=>new Response(events.map(e=>JSON.stringify(e)).join('\n'))) as typeof fetch});
  let text=''; for await(const chunk of answer(context()))text+=chunk;
  assert.equal(text,'查好了。'); assert.equal(seen.length,2); assert.ok(seen.every(e=>!('text' in e)));
});

test('only valid message IDs bind receipts and next request carries the same identity',async()=>{
 const receipt={conversationId:'c',assistantMessageId:'m1',answerHash:'a'.repeat(64),state:'partial',answerSubmittedSamples:160,attribution:'known'};
 for(const id of [undefined,'',7,'x'.repeat(201),'m1']){
  const bound:unknown[][]=[];let body:any;
  const answer=createNativeSharedChat({baseUrl:'http://localhost:1',settings:()=>({routingMode:'work',conversationId:'c'}),onConversation:()=>{},playbackContext:()=>receipt,onAnswer:(...args)=>{bound.push(args)},fetch:(async(_url,init)=>{body=JSON.parse(init!.body as string);return new Response(JSON.stringify({type:'done',conversationId:'c',assistantMessageId:id,answer:'收到。'}))}) as typeof fetch});
  let text='';for await(const part of answer(context()))text+=part;
  assert.equal(text,'收到。');assert.deepEqual(body.voicePlayback,receipt);assert.equal(bound.length,id==='m1'?1:0);
  if(id==='m1'){assert.equal(bound[0][2],'m1');assert.match(bound[0][1] as string,/^[a-f0-9]{64}$/);}
 }
});
