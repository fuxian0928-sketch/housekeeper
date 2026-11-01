import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

// Synthetic isolated data only. No settings, credentials, cloud calls or audio.
process.env.AI_SECRETARY_DB_PATH = join(mkdtempSync(join(tmpdir(), 'voice-prefetch-benchmark-')), 'fixture.db');
const { database, initializeDatabase } = await import('../../server/db.js');
initializeDatabase();
const { ExistingMemoryContextProvider } = await import('../../server/domain/memories/memory-context.js');
const { VoicePrefetchCandidates } = await import('../../server/domain/memories/voice-prefetch-candidates.js');
const provider = new ExistingMemoryContextProvider();
const cache = new VoicePrefetchCandidates();
const signal = new AbortController().signal;
const query = '查一下当前项目的设计约束';
const request = { query, mode: 'life' as const, projectId: null, conversationId: null };
const results: unknown[] = [];
const percentile = (values: number[], p: number) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
try {
  const insert = database.prepare(`INSERT INTO memories(id,content,memory_type,status,created_at,updated_at) VALUES(?,?,'fact','confirmed',?,?)`);
  for (const count of [100, 1000, 10000]) {
    database.prepare('DELETE FROM memories').run();
    const timestamp = new Date().toISOString();
    database.exec('BEGIN');
    try {
      for (let i=0;i<count;i++) insert.run(`m${i}`,`项目 ${i} 的设计约束：`+'维护清晰的信息结构和可验证的结论。'.repeat(12),timestamp,timestamp);
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    const normal: number[] = [], prepare: number[] = [], consume: number[] = [];
    for (let i=0;i<23;i++) {
      let start=performance.now(); const expected=await provider.retrieve({query,projectIds:[],limit:12,signal}); const normalMs=performance.now()-start;
      start=performance.now(); const ready=await cache.prepare(request,signal); const prepareMs=performance.now()-start;
      start=performance.now(); const reused=cache.consume(ready.token,request); const consumeMs=performance.now()-start;
      if (!reused || JSON.stringify(reused.facts)!==JSON.stringify(expected.facts)) throw Error('BENCHMARK_RESULT_MISMATCH');
      if(i>=3){normal.push(normalMs);prepare.push(prepareMs);consume.push(consumeMs);}
    }
    results.push({rows:count,samples:20,normalMs:{p50:percentile(normal,.5),p95:percentile(normal,.95)},prepareMs:{p50:percentile(prepare,.5),p95:percentile(prepare,.95)},consumeMs:{p50:percentile(consume,.5),p95:percentile(consume,.95)}});
  }
  const report={completedAt:new Date().toISOString(),synthetic:true,scope:'local-memory-only-not-voice-latency',results};
  if(process.argv[2])writeFileSync(resolve(process.argv[2]),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { database.close(); }
