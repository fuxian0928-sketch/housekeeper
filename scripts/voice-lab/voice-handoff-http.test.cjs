const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }

test('voice standby starts a new conversation and related handoff survives later turns only', { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-handoff-http-'));
  const dbPath = join(directory, 'fixture.db');
  const streamInputs = [], relevanceInputs = [];
  const provider = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const payload = JSON.parse(raw);
      const content = payload.messages.at(-1).content;
      if (payload.stream) {
        if (content.includes('simulate failure')) { response.statusCode = 503; response.end('{}'); return; }
        streamInputs.push(JSON.parse(content));
        response.setHeader('Content-Type', 'text/event-stream');
        response.end('data: '+JSON.stringify({ choices: [{ delta: { content: '收到，主人。' }, finish_reason: null }] })+'\n\ndata: [DONE]\n\n');
        return;
      }
      let result;
      const input = JSON.parse(content);
      if (input.transcript) result = '主人准备面试，正在梳理项目经历。';
      else if (input.newMessage && input.previousConversation) {
        relevanceInputs.push(input);
        result = JSON.stringify({ related: !input.newMessage.includes('笑话') });
      } else if (input.observation) result = JSON.stringify({ memories: [], reflection: '' });
      else result = JSON.stringify({ excerpts: [] });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: result }, finish_reason: 'stop' }] }));
    } catch { response.statusCode = 500; response.end('{}'); }
  });
  let child;
  let output = '';
  try {
    const providerPort = await listen(provider);
    const reservation = createServer(); const port = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AI_SECRETARY_|OPENAI_|DASHSCOPE_|TAVILY_)/.test(key)));
    Object.assign(env, { AI_SECRETARY_DB_PATH: dbPath, AI_SECRETARY_SKILLS_DIR: join(directory, 'skills'),
      AI_SECRETARY_PORT: String(port), AI_SECRETARY_HOST: '127.0.0.1', AI_SECRETARY_API_KEY: 'fixture-only', AI_SECRETARY_SEED_DEMO: '0' });
    child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('server/index.ts')],
      { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    child.stdout.on('data', data => { output = (output + data).slice(-4000); });
    child.stderr.on('data', data => { output = (output + data).slice(-4000); });
    const root = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i=0; i<350; i++) {
      if (child.exitCode !== null) throw Error('Isolated server exited: ' + output);
      try { if ((await fetch(root+'/api/health', { signal: AbortSignal.timeout(250) })).ok) { ready=true; break; } } catch {}
      await delay(100);
    }
    assert.equal(ready, true, 'isolated server readiness: '+output);
    const json = async (path, body, method='POST') => {
      const response = await fetch(root+path, { method, headers: { 'Content-Type':'application/json' },
        ...(body===undefined?{}:{body:JSON.stringify(body)}), signal: AbortSignal.timeout(15000) });
      assert.equal(response.ok, true, `${path}: ${response.status} ${await response.clone().text()}`);
      return response.json();
    };
    await json('/api/settings', { aiEnabled:true, apiBaseUrl:`http://127.0.0.1:${providerPort}/v1`, model:'fixture-model',
      voiceWebSearchEnabled:false, webSearchPolicy:'off' }, 'PATCH');
    const askRaw = async (message, conversationId=null) => {
      const response = await fetch(root+'/api/chat/stream', { method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ message, conversationId, deviceId:'device-a1', interactionMode:'voice', routingMode:'life', scope:'memory' }), signal:AbortSignal.timeout(15000) });
      assert.equal(response.ok,true);
      const events = (await response.text()).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
      if (!conversationId) assert.ok(events.some(event=>event.type==='conversation-started' && event.conversationId && event.createdAt),JSON.stringify(events));
      return events;
    };
    const ask = async (message, conversationId=null) => {
      const events = await askRaw(message,conversationId);
      const done = events.find(event=>event.type==='done');
      assert.ok(done, JSON.stringify(events)); return done;
    };
    const first = await ask('明天面试，帮我梳理项目经历');
    const previousTime = new DatabaseSync(dbPath, { readOnly:true });
    const beforeClose = previousTime.prepare('SELECT updated_at FROM conversations WHERE id=?').get(first.conversationId).updated_at;
    previousTime.close();
    assert.deepEqual(await json('/api/voice/session-close',{conversationId:first.conversationId,routingMode:'life',projectId:null,deviceId:'device-a1'}),
      {closed:true,handoff:true,created:true});
    const db = new DatabaseSync(dbPath, { readOnly:true });
    for(let i=0;i<100;i++) {
      if(db.prepare('SELECT summary FROM voice_session_handoffs WHERE source_conversation_id=?').get(first.conversationId)?.summary) break;
      await delay(20);
    }
    const second = await ask('继续刚才的面试项目经历');
    assert.notEqual(second.conversationId,first.conversationId);
    assert.match(streamInputs.at(-1).summary,/主人准备面试/);
    assert.equal(relevanceInputs.length,1);
    const saved = db.prepare('SELECT compressed_summary,compressed_at FROM conversations WHERE id=?').get(second.conversationId);
    assert.match(saved.compressed_summary,/上一次语音会话的相关信息/);
    assert.equal(saved.compressed_at,null);
    assert.equal(db.prepare('SELECT updated_at FROM conversations WHERE id=?').get(first.conversationId).updated_at,beforeClose);
    await ask('先从项目背景讲起',second.conversationId);
    assert.match(streamInputs.at(-1).summary,/主人准备面试/);
    assert.equal(relevanceInputs.length,1,'relevance runs only on the first new turn');
    assert.deepEqual(await json('/api/voice/session-close',{conversationId:second.conversationId,routingMode:'life',projectId:null,deviceId:'device-a1'}),
      {closed:true,handoff:true,created:true});
    const secondSnapshot = db.prepare('SELECT snapshot FROM voice_session_handoffs WHERE source_conversation_id=?').get(second.conversationId).snapshot;
    assert.match(secondSnapshot,/主人准备面试/);
    assert.match(secondSnapshot,/先从项目背景讲起/);
    const third = await ask('继续把刚才面试项目的背景说完');
    assert.notEqual(third.conversationId,second.conversationId);
    assert.match(streamInputs.at(-1).summary,/主人准备面试/);
    assert.equal(relevanceInputs.length,2);
    assert.deepEqual(await json('/api/voice/session-close',{conversationId:third.conversationId,routingMode:'life',projectId:null,deviceId:'device-a1'}),
      {closed:true,handoff:true,created:true});
    const unrelated = await ask('给我讲个笑话');
    assert.notEqual(unrelated.conversationId,third.conversationId);
    assert.equal(streamInputs.at(-1).summary,'');
    assert.equal(db.prepare('SELECT compressed_summary FROM conversations WHERE id=?').get(unrelated.conversationId).compressed_summary,null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voice_session_handoffs').get().n,0);
    const failed = await askRaw('simulate failure');
    const failedId = failed.find(event=>event.type==='conversation-started').conversationId;
    assert.ok(failed.some(event=>event.type==='error'));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role='user'").get(failedId).n,1);
    assert.deepEqual(await json('/api/voice/session-close',{conversationId:failedId,routingMode:'life',projectId:null,deviceId:'device-a1'}),
      {closed:true,handoff:true,created:true});
    const staleIdEvents = await askRaw('给我讲个笑话',first.conversationId);
    const rebound = staleIdEvents.find(event=>event.type==='conversation-started');
    assert.equal(rebound.replacedConversationId,first.conversationId);
    assert.notEqual(rebound.conversationId,first.conversationId);
    db.close();
  } finally {
    if (child && child.exitCode===null) { child.kill(); await once(child,'exit'); }
    provider.closeAllConnections(); await new Promise(resolve=>provider.close(resolve));
  }
});
