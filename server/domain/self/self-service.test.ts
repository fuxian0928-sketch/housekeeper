import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('diagnostics are scoped and redact error content; tool planner cannot run arbitrary tools', async () => {
  const dir=mkdtempSync(join(tmpdir(),'self-service-'));
  process.env.AI_SECRETARY_DB_PATH=join(dir,'test.db');
  const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();
  const {selfRequestContext,recordDiagnostic,readDiagnostics}=await import('./diagnostics.js');
  const {SelfService}=await import('./self-service.js');
  const {collectSelfEvidence}=await import('../../orchestration/self-inspection.js');
  selfRequestContext.run({requestId:'a',conversationId:'a',stage:'test'},()=>recordDiagnostic('model','failed',10,'chosen',new Error('401 secret-token private-user-text')));
  selfRequestContext.run({requestId:'b',conversationId:'b',stage:'test'},()=>recordDiagnostic('model','failed',10,'other',new Error('another private error')));
  const result=readDiagnostics('a');
  assert.equal(result.events.length,1);assert.equal(result.events[0].errorCode,'authentication');
  assert.doesNotMatch(JSON.stringify(result),/secret-token|private-user-text|other/);
  await selfRequestContext.run({requestId:'a',conversationId:'a',stage:'answer'},()=>selfRequestContext.exit(async()=>{
    await Promise.resolve();
    recordDiagnostic('background-memory','succeeded',1,'default');
  }));
  assert.equal(readDiagnostics('a').events.length,1,'background work must not inherit the chat trace');
  const runtime={model:'chosen',defaultModel:'default',aiEnabled:true,hasApiKey:true,hasRetrievalApiKey:false,hasWebSearchApiKey:false,webSearchPolicy:'off',mode:'local',clientVersion:'1.1.10',conversationId:'a',requestId:'a'};
  const service=new SelfService();
  assert.equal(service.runtime(runtime).currentTurnModel,'chosen');
  assert.equal(service.runtime(runtime).model.reachability,'not_probed');
  const called:string[]=[];
  const evidence=await collectSelfEvidence({question:'了解你自己',runtime,signal:new AbortController().signal,execute:(name,args,context)=>{called.push(name);return service.execute(name,args,context);},complete:async()=>JSON.stringify({calls:[{name:'run_shell',args:{command:'echo bad'}}]})});
  assert.deepEqual(called,['get_runtime_status','get_self_capabilities']);assert.equal(evidence.at(-1)?.tool,'planner');
  assert.throws(()=>service.execute('read_own_code',{path:'server/test.ts',startLine:NaN},runtime));
  database.close();
});
