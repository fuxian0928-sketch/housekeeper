import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { VoiceSessionHandoffService, ensureVoiceSessionHandoffTables } from './voice-session-handoff.js';

function fixture(complete: ConstructorParameters<typeof VoiceSessionHandoffService>[1]) {
  const database = new DatabaseSync(':memory:');
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE conversations(id TEXT PRIMARY KEY,scope_type TEXT NOT NULL,project_id TEXT,title TEXT,created_at TEXT,updated_at TEXT,compressed_summary TEXT,compressed_at TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
    INSERT INTO conversations VALUES('old','project','system-voice-conversations','原对话','2026-09-01T09:00:00Z','2026-09-01T09:05:00Z',NULL,NULL);
    INSERT INTO conversations VALUES('new','project','system-voice-conversations','新对话','2026-09-01T09:06:00Z','2026-09-01T09:06:00Z',NULL,NULL);
    INSERT INTO messages VALUES('m1','old','user','明天要准备面试，请帮我梳理项目经历','2026-09-01T09:01:00Z');
    INSERT INTO messages VALUES('m2','old','assistant','可以先梳理背景、行动和结果。','2026-09-01T09:02:00Z');`);
  ensureVoiceSessionHandoffTables(database);
  const service = new VoiceSessionHandoffService(database, complete, () => '2026-09-01T09:06:00Z');
  service.noteTurn('old', { routingMode: 'life', projectId: null }, 'device-a1');
  return { database, service };
}

test('standby snapshots once without altering message or conversation timestamps; related next turn consumes once', async () => {
  const { database, service } = fixture(async (_input, options) => options.maxTokens === 60 ? '{"related":true}' : '主人明天面试，正在梳理项目经历。');
  try {
    // A remembered work-project selection must not block closing a current life session.
    assert.deepEqual(service.close('old', { routingMode: 'life', projectId: 'previous-project' }, 'device-a1'), { closed: true, handoff: true, created: true });
    assert.deepEqual(service.close('old', { routingMode: 'life', projectId: null }, 'device-a1'), { closed: true, handoff: true, created: false });
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM voice_session_handoffs').get() as { n: number }).n, 1);
    assert.equal((database.prepare("SELECT source_last_message_at FROM voice_session_handoffs WHERE source_conversation_id='old'").get() as {source_last_message_at:string}).source_last_message_at,'2026-09-01T09:02:00Z');
    assert.equal((database.prepare("SELECT updated_at FROM conversations WHERE id='old'").get() as { updated_at: string }).updated_at, '2026-09-01T09:05:00Z');
    assert.equal((database.prepare("SELECT created_at FROM messages WHERE id='m2'").get() as { created_at: string }).created_at, '2026-09-01T09:02:00Z');
    assert.equal(await service.summarize('old'), true);
    const handoff = await service.takeForFirstTurn('刚才那个面试项目经历，先说哪一段？', { routingMode: 'life', projectId: null }, 'device-a1', 'new');
    assert.match(handoff ?? '', /主人明天面试/);
    assert.equal(await service.takeForFirstTurn('继续', { routingMode: 'life', projectId: null }, 'device-a1', 'new'), null);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM voice_session_handoffs').get() as { n: number }).n, 0);
  } finally { database.close(); }
});

test('unrelated next turn drops one-shot bridge while retaining original transcript', async () => {
  const { database, service } = fixture(async () => '{"related":false}');
  try {
    service.close('old', { routingMode: 'life', projectId: null }, 'device-a1');
    assert.equal(await service.takeForFirstTurn('今天天气如何？', { routingMode: 'life', projectId: null }, 'device-a1', 'new'), null);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM voice_session_handoffs').get() as { n: number }).n, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id='old'").get() as { n: number }).n, 2);
  } finally { database.close(); }
});

test('different project scope never reaches relevance model; switch within source excludes earlier segment', async () => {
  let calls = 0;
  const { database, service } = fixture(async () => { calls++; return '{"related":true}'; });
  try {
    service.noteTurn('old', { routingMode: 'work', projectId: 'project-a' }, 'device-a1');
    database.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run('m3','old','user','项目 A 的接口今天改完了','2026-09-01T09:03:00Z');
    service.close('old', { routingMode: 'work', projectId: 'project-a' }, 'device-a1');
    const snapshot = (database.prepare("SELECT snapshot FROM voice_session_handoffs WHERE source_conversation_id='old'").get() as { snapshot: string }).snapshot;
    assert.match(snapshot, /项目 A/); assert.doesNotMatch(snapshot, /面试/);
    assert.equal(await service.takeForFirstTurn('项目 B 的接口如何？', { routingMode: 'work', projectId: 'project-b' }, 'device-a1', 'new'), null);
    assert.equal(calls, 0);
  } finally { database.close(); }
});

test('late background summarization cannot revive claimed or consumed bridge', async () => {
  let release!: (value: string) => void;
  const { database, service } = fixture((_input, options) => options.maxTokens === 450
    ? new Promise<string>(resolve => { release = resolve; }) : Promise.resolve('{"related":false}'));
  try {
    service.close('old', { routingMode: 'life', projectId: null }, 'device-a1');
    const pending = service.summarize('old');
    await service.takeForFirstTurn('新的话题', { routingMode: 'life', projectId: null }, 'device-a1', 'new');
    release('迟到的摘要，不能复活');
    assert.equal(await pending, false);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM voice_session_handoffs').get() as { n: number }).n, 0);
  } finally { database.close(); }
});

test('relevance errors fail closed and preserve bridge for a later valid wake', async () => {
  let attempts = 0;
  const { database, service } = fixture(async () => { if (++attempts === 1) throw Error('model unavailable'); return '{"related":true}'; });
  try {
    service.close('old', { routingMode: 'life', projectId: null }, 'device-a1');
    assert.equal(await service.takeForFirstTurn('继续', { routingMode: 'life', projectId: null }, 'device-a1', 'new'), null);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM voice_session_handoffs').get() as { n: number }).n, 1);
    assert.match(await service.takeForFirstTurn('继续刚才的面试话题', { routingMode: 'life', projectId: null }, 'device-a1', 'new') ?? '', /面试/);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM voice_session_handoffs').get() as { n: number }).n, 0);
  } finally { database.close(); }
});

test('two clients cannot claim or delete each other\'s pending handoff', async () => {
  const { database, service } = fixture(async () => '{"related":true}');
  try {
    database.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run('old-b','project','system-voice-conversations','B 对话','2026-09-01T09:01:00Z','2026-09-01T09:04:00Z',null,null);
    database.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run('mb','old-b','user','设备 B 在聊旅行','2026-09-01T09:04:00Z');
    service.noteTurn('old-b',{routingMode:'life',projectId:null},'device-b2');
    service.close('old',{routingMode:'life',projectId:null},'device-a1');
    service.close('old-b',{routingMode:'life',projectId:null},'device-b2');
    assert.equal(await service.takeForFirstTurn('继续', {routingMode:'life',projectId:null}, null, 'new'),null);
    assert.match(await service.takeForFirstTurn('继续我的面试', {routingMode:'life',projectId:null}, 'device-a1', 'new') ?? '',/面试/);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM voice_session_handoffs WHERE device_id='device-b2'").get() as {n:number}).n,1);
    assert.match(await service.takeForFirstTurn('继续旅行', {routingMode:'life',projectId:null}, 'device-b2', 'new') ?? '',/旅行/);
  } finally { database.close(); }
});

test('missing device id cannot bridge, while same-device global auto conversations can bridge', async () => {
  const first = fixture(async () => '{"related":true}');
  try {
    first.database.prepare("UPDATE voice_session_scopes SET device_id=NULL WHERE conversation_id='old'").run();
    assert.deepEqual(first.service.close('old',{routingMode:'life',projectId:null},null),{closed:true,handoff:false,created:false});
    assert.equal(first.service.cannotResume('old',null),true);
    assert.equal((first.database.prepare('SELECT COUNT(*) AS n FROM voice_session_handoffs').get() as {n:number}).n,0);
  } finally { first.database.close(); }
  const second = fixture(async () => '{"related":true}');
  try {
    second.service.noteTurn('old',{routingMode:'auto',projectId:null},'device-a1');
    second.database.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run('auto-turn','old','user','自动模式下聊到项目','2026-09-01T09:03:00Z');
    assert.deepEqual(second.service.close('old',{routingMode:'auto',projectId:null},'device-a1'),{closed:true,handoff:true,created:true});
    assert.match(await second.service.takeForFirstTurn('继续刚才的项目话题',{routingMode:'auto',projectId:null},'device-a1','new') ?? '',/自动模式下聊到项目/);
  } finally { second.database.close(); }
});

test('a legacy voice transcript without a proven device owner cannot be resumed or handed off', () => {
  const { database, service } = fixture(async () => '{"related":true}');
  try {
    database.prepare("DELETE FROM voice_session_scopes WHERE conversation_id='old'").run();
    assert.equal(service.cannotResume('old','device-a1'),true);
    assert.deepEqual(service.close('old',{routingMode:'life',projectId:null},'device-a1'),{closed:true,handoff:false,created:false});
    assert.equal(service.peekLatest('device-a1'),null);
  } finally { database.close(); }
});

test('a concurrent first turn cannot claim a handoff already under relevance review', async () => {
  let release!: (value:string)=>void;
  const { database, service } = fixture(() => new Promise(resolve => { release = resolve; }));
  try {
    service.close('old',{routingMode:'life',projectId:null},'device-a1');
    const first = service.takeForFirstTurn('继续面试',{routingMode:'life',projectId:null},'device-a1','new');
    const second = service.takeForFirstTurn('另一个同时到达的请求',{routingMode:'life',projectId:null},'device-a1','new');
    release('{"related":true}');
    assert.match(await first ?? '',/面试/);
    assert.equal(await second,null);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM voice_session_handoffs').get() as {n:number}).n,0);
  } finally { database.close(); }
});

test('work continuation can inspect prior project before routing and consume only after exact project match', async () => {
  const { database, service } = fixture(async () => '{"related":true}');
  try {
    service.noteTurn('old',{routingMode:'work',projectId:'project-a'},'device-a1');
    database.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run('work-msg','old','user','项目 A 的任务进展','2026-09-01T09:03:00Z');
    service.close('old',{routingMode:'work',projectId:'project-a'},'device-a1');
    const candidate = service.peekLatest('device-a1');
    assert.equal(candidate?.projectId,'project-a');
    const preview = await service.previewForFirstTurn('继续刚才那个任务','work','device-a1',candidate!.sourceConversationId);
    assert.match(preview?.context ?? '',/项目 A 的任务进展/);
    assert.equal((database.prepare("SELECT state FROM voice_session_handoffs WHERE source_conversation_id='old'").get() as {state:string}).state,'pending');
    assert.match(service.consumePreview(preview!,{routingMode:'work',projectId:'project-a'},'device-a1','new') ?? '',/项目 A 的任务进展/);
    assert.equal(service.peekLatest('device-a1'),null);
  } finally { database.close(); }
});

test('a project switch discards inspected prior context and a preview error does not consume it', async () => {
  let fail = true;
  const { database, service } = fixture(async () => { if (fail) throw Error('temporary outage'); return '{"related":true}'; });
  try {
    service.noteTurn('old',{routingMode:'auto',projectId:'project-a'},'device-a1');
    database.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run('work-msg','old','user','项目 A 的任务进展','2026-09-01T09:03:00Z');
    service.close('old',{routingMode:'auto',projectId:'project-a'},'device-a1');
    const candidate = service.peekLatest('device-a1')!;
    const failed = await service.previewForFirstTurn('继续那个任务','auto','device-a1',candidate.sourceConversationId);
    assert.equal(failed?.verdict,'retry');
    assert.equal(service.consumePreview(failed!,{routingMode:'auto',projectId:'project-a'},'device-a1','new'),null);
    assert.ok(service.peekLatest('device-a1'));
    fail = false;
    const related = await service.previewForFirstTurn('继续那个任务','auto','device-a1',candidate.sourceConversationId);
    assert.equal(related?.verdict,'related');
    assert.equal(service.consumePreview(related!,{routingMode:'auto',projectId:'project-b'},'device-a1','new'),null);
    assert.equal(service.peekLatest('device-a1'),null);
  } finally { database.close(); }
});

test('scope resolution after the first user message keeps that message and excludes earlier project', () => {
  const { database, service } = fixture(async () => '{"related":true}');
  try {
    service.noteTurn('old',{routingMode:'work',projectId:null},'device-a1');
    database.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run('new-message','old','user','项目 B 今天要继续','2026-09-01T09:03:00Z');
    service.noteTurn('old',{routingMode:'work',projectId:'project-b'},'device-a1','new-message');
    service.close('old',{routingMode:'work',projectId:'project-b'},'device-a1');
    const row = database.prepare("SELECT snapshot FROM voice_session_handoffs WHERE source_conversation_id='old'").get() as {snapshot:string};
    assert.match(row.snapshot,/项目 B 今天要继续/);
    assert.doesNotMatch(row.snapshot,/面试/);
    assert.equal((database.prepare("SELECT source_last_message_at FROM voice_session_handoffs WHERE source_conversation_id='old'").get() as {source_last_message_at:string}).source_last_message_at,'2026-09-01T09:03:00Z');
  } finally { database.close(); }
});

test('interrupted relevance releases the bridge to an immediate same-device retry', async () => {
  let calls = 0;
  const { database, service } = fixture(async () => ++calls === 1 ? new Promise<string>(() => {}) : '{"related":true}');
  try {
    service.close('old',{routingMode:'life',projectId:null},'device-a1');
    const interrupted = new AbortController();
    const first = service.takeForFirstTurn('继续面试',{routingMode:'life',projectId:null},'device-a1','new',interrupted.signal);
    const second = service.takeForFirstTurn('继续我的面试',{routingMode:'life',projectId:null},'device-a1','new');
    interrupted.abort();
    assert.equal(await first,null);
    assert.match(await second ?? '',/面试/);
    assert.equal(calls,2);
    assert.equal(service.peekLatest('device-a1'),null);
  } finally { database.close(); }
});

test('summary attach and source consumption are atomic when database write fails', async () => {
  const { database, service } = fixture(async () => '{"related":true}');
  try {
    service.close('old',{routingMode:'life',projectId:null},'device-a1');
    database.exec(`CREATE TRIGGER fail_handoff_attach BEFORE UPDATE OF compressed_summary ON conversations
      WHEN NEW.id='new' BEGIN SELECT RAISE(ABORT,'injected attach failure'); END;`);
    await assert.rejects(service.takeForFirstTurn('继续面试',{routingMode:'life',projectId:null},'device-a1','new'),/injected attach failure/);
    assert.equal((database.prepare("SELECT compressed_summary FROM conversations WHERE id='new'").get() as {compressed_summary:string|null}).compressed_summary,null);
    assert.equal((database.prepare("SELECT state FROM voice_session_handoffs WHERE source_conversation_id='old'").get() as {state:string}).state,'pending');
    database.exec('DROP TRIGGER fail_handoff_attach');
    assert.match(await service.takeForFirstTurn('继续面试',{routingMode:'life',projectId:null},'device-a1','new') ?? '',/面试/);
    assert.match((database.prepare("SELECT compressed_summary FROM conversations WHERE id='new'").get() as {compressed_summary:string}).compressed_summary,/面试/);
    assert.equal(service.peekLatest('device-a1'),null);
  } finally { database.close(); }
});
