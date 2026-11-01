import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('settings, bounded summaries and recoverable memory preserve user information', async context => {
  process.env.AI_SECRETARY_DB_PATH = join(mkdtempSync(join(tmpdir(),'secretary-continuity-')),'test.db');
  const { database, initializeDatabase } = await import('../db.js');
  initializeDatabase();
  context.after(() => database.close());
  const { compressionTranscript,saveCompression,loadConversationHistory } = await import('../domain/conversations/conversation-service.js');
  const { recordMemoryObservation,curateObservation } = await import('../domain/memories/memory-curator.js');
  const { claimMemoryJob,assertMemoryJobOwner,recoverExpiredMemoryJobs } = await import('../domain/memories/memory-jobs.js');

  await context.test('restart initialization keeps all disabled memory policies disabled', () => {
    for (const key of ['memory_auto_capture','memory_auto_apply','memory_auto_confirm']) database.prepare("UPDATE app_settings SET value='0' WHERE key=?").run(key);
    initializeDatabase();
    for (const key of ['memory_auto_capture','memory_auto_apply','memory_auto_confirm']) assert.equal(database.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value,'0');
    assert.equal(recordMemoryObservation({sourceType:'manual',sourceLabel:'关闭后',content:'不应自动记录'}),null);
    database.prepare("UPDATE app_settings SET value='1' WHERE key IN ('memory_auto_capture','memory_auto_apply','memory_auto_confirm')").run();
  });

  await context.test('messages arriving during compression remain in context, even with old/equal timestamps', () => {
    database.prepare("INSERT INTO conversations(id,scope_type,title,created_at,updated_at) VALUES('bounded','memory','周报','2026-10-21','2026-10-21')").run();
    const add = database.prepare("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,'bounded',?,?,?)");
    add.run('before-user','user','请整理周报','2026-10-21T01:00:00Z');
    add.run('before-answer','assistant','待确认','2026-10-21T01:00:00Z');
    const first = compressionTranscript('bounded').snapshot;
    const competing = compressionTranscript('bounded').snapshot;
    add.run('during-user','user','补上风险','2026-10-20T01:00:00Z');
    add.run('during-answer','assistant','收到补充','2026-10-21T01:00:00Z');
    saveCompression('bounded','已确定周报目标',first);
    assert.deepEqual(loadConversationHistory('bounded').map(message=>message.id),['during-user','during-answer']);
    assert.throws(()=>saveCompression('bounded','较旧的并发摘要',competing),/较新的摘要/);
    const editSnapshot = compressionTranscript('bounded').snapshot;
    database.prepare("UPDATE messages SET content='已更正风险' WHERE id='during-user'").run();
    assert.throws(()=>saveCompression('bounded','过时内容',editSnapshot),/消息已改变/);
    database.prepare("UPDATE conversations SET compressed_through_message_id=NULL WHERE id='bounded'").run();
    assert.equal(loadConversationHistory('bounded').length,4,'legacy summaries without a proven boundary keep original messages');
  });

  await context.test('expired owners cannot commit; recovered extraction reuses output and item receipts', async () => {
    const id = recordMemoryObservation({sourceType:'manual',sourceId:'review-input',sourceLabel:'事务偏好',content:'我希望每周五整理周报'})!;
    const staleToken = claimMemoryJob(id)!;
    assert.equal(claimMemoryJob(id),null,'only one owner may claim a pending observation');
    const extraction = JSON.stringify({memories:[{action:'add',content:'用户希望每周五整理项目周报',memoryType:'preference',scope:'global',subject:'user',attribute:'work_style',facet:'周报时间',evidence:{sourceId:'review-input',quote:'我希望每周五整理周报'}}]});
    database.prepare("UPDATE memory_observations SET lease_expires_at='2000-01-01',extraction_json=? WHERE id=?").run(extraction,id);
    recoverExpiredMemoryJobs();
    assert.throws(()=>assertMemoryJobOwner(id,staleToken),/取消或接管/);
    let modelCalls = 0;
    const unexpectedModel = async () => { modelCalls++; throw new Error('cached extraction should be reused'); };
    const first = await curateObservation(id,unexpectedModel);
    assert.equal(first.memories.length,1);
    const memoryId = first.memories[0];
    const evidenceCount = database.prepare('SELECT evidence_count FROM memories WHERE id=?').get(memoryId)?.evidence_count;
    // Simulate a process dying after the atomic item write but before the final job checkpoint.
    database.prepare("UPDATE memory_observations SET status='processing',lease_token='dead',lease_expires_at='2000-01-01' WHERE id=?").run(id);
    recoverExpiredMemoryJobs();
    const resumed = await curateObservation(id,unexpectedModel);
    assert.deepEqual(resumed.memories,[memoryId]);
    assert.equal(modelCalls,0);
    assert.equal(database.prepare('SELECT evidence_count FROM memories WHERE id=?').get(memoryId)?.evidence_count,evidenceCount);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_extraction_items WHERE observation_id=?').get(id)?.count,1);

    database.prepare("UPDATE app_settings SET value='0' WHERE key IN ('memory_auto_apply','memory_auto_confirm')").run();
    const candidateId = recordMemoryObservation({sourceType:'manual',sourceId:'candidate-input',sourceLabel:'更正建议',content:'周报也许改在周四'})!;
    await curateObservation(candidateId,async()=>JSON.stringify({memories:[{action:'update',targetMemoryId:memoryId,content:'用户希望周四整理项目周报',memoryType:'preference',scope:'global',subject:'user',attribute:'work_style',facet:'周报时间',evidence:{sourceId:'candidate-input',quote:'周报也许改在周四'}}]}));
    assert.equal(database.prepare('SELECT content FROM memories WHERE id=?').get(memoryId)?.content,'用户希望每周五整理项目周报');
    assert.equal(database.prepare("SELECT status FROM memories WHERE content='用户希望周四整理项目周报'").get()?.status,'candidate');
    database.prepare('DELETE FROM memories WHERE id=?').run(memoryId);
    database.prepare("UPDATE memory_observations SET status='pending' WHERE id=?").run(id);
    assert.deepEqual((await curateObservation(id,unexpectedModel)).memories,[]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memories WHERE content='用户希望每周五整理项目周报'").get()?.count,0,'forgotten facts must not be recreated by a recovered job');
  });

  await context.test('deleted sources cannot write late model output; failures have bounded attempts', async () => {
    const removed = recordMemoryObservation({sourceType:'manual',sourceId:'removed-source',sourceLabel:'删除来源',content:'这条来源会被删除'})!;
    await assert.rejects(curateObservation(removed,async()=>{
      database.prepare('DELETE FROM memory_observations WHERE id=?').run(removed);
      return JSON.stringify({memories:[{action:'add',content:'被删除来源的内容不应复活',scope:'global'}]});
    }),/取消或接管/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memories WHERE content='被删除来源的内容不应复活'").get()?.count,0);
    const retryId = recordMemoryObservation({sourceType:'manual',sourceId:'failing-source',sourceLabel:'服务失败',content:'测试有上限的失败重试'})!;
    for (let attempt=0;attempt<5;attempt++) {
      database.prepare("UPDATE memory_observations SET status='pending' WHERE id=?").run(retryId);
      await assert.rejects(curateObservation(retryId,async()=>{throw new Error('服务暂不可用');}),/服务暂不可用/);
    }
    const job = database.prepare('SELECT status,attempt_count,next_attempt_at FROM memory_observations WHERE id=?').get(retryId)!;
    assert.equal(job.status,'failed');
    assert.equal(job.attempt_count,5);
    assert.ok(Date.parse(String(job.next_attempt_at))>Date.now());
    database.prepare("UPDATE memory_observations SET status='pending' WHERE id=?").run(retryId);
    assert.equal(claimMemoryJob(retryId),null);
  });
});
