import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';
import { registerVoiceSessionHandoffRoutes } from './voice-session-handoff.js';
import { VoiceSessionHandoffService, ensureVoiceSessionHandoffTables } from '../domain/conversations/voice-session-handoff.js';

test('close HTTP request acknowledges durable snapshot before optional summarization completes', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE conversations(id TEXT PRIMARY KEY,scope_type TEXT,project_id TEXT,compressed_summary TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,created_at TEXT);
    INSERT INTO conversations VALUES('voice','project','system-voice-conversations',NULL);
    INSERT INTO messages VALUES('message','voice','user','后面继续聊我的项目经历','2026-09-01T09:00:00Z');`);
  ensureVoiceSessionHandoffTables(database);
  let summaryStarted!: () => void;
  const started = new Promise<void>(resolve => { summaryStarted = resolve; });
  let release!: (value: string) => void;
  const service = new VoiceSessionHandoffService(database, async () => {
    summaryStarted();
    return new Promise<string>(resolve => { release = resolve; });
  });
  service.noteTurn('voice', { routingMode: 'life', projectId: null }, 'device-a1');
  const app = express(); app.use(express.json()); registerVoiceSessionHandoffRoutes(app, service);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/voice/session-close`;
  try {
    const close = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'voice', routingMode: 'life', projectId: null, deviceId: 'device-a1' }) });
    const response = await close();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { closed: true, handoff: true, created: true });
    await started;
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM voice_session_handoffs').get() as { n: number }).n, 1);
    assert.deepEqual(await (await close()).json(), { closed: true, handoff: true, created: false });
    const deleted = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'deleted-voice' }) });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { closed: true, handoff: false, created: false });
    database.prepare("INSERT INTO conversations VALUES('text','memory',NULL,NULL)").run();
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'text' }) })).status, 404);
    release('待续的项目经历');
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); database.close();
  }
});
