import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';

test('voice uses one model call, shows the complete original and sends separate narration',async t=>{
 process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'voice-presentation-')),'test.db');
 const {database,initializeDatabase}=await import('../db.js');initializeDatabase();t.after(()=>database.close());
 const {registerAgentRoutes}=await import('./agent.js');let calls=0;
 const answer='## 项目原文\n\n**预算30万元**（待核实），下一步核对合同。',narration='预算是30万元，不过还需要核实。接下来先核对合同。';
 const app=express();app.use(express.json());
 registerAgentRoutes(app,{canUseModel:()=>true,defaultModel:()=> 'test',requestSignal:()=>new AbortController().signal,model:()=>async(messages,_tools,options)=>{
  calls++;assert.ok(messages[0].content?.includes('answer和narration'));
  const content=answer+'\n\n'+JSON.stringify({answer,narration});options.onText?.(content.slice(0,15));options.onText?.(content.slice(15));
  return{content,toolCalls:[],finishReason:'stop'};
 }});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/agent/runs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'介绍项目进展',interactionMode:'voice',voicePresentation:'dual-v1'})});
 const events=(await response.text()).trim().split('\n').map(s=>JSON.parse(s)),done=events.at(-1);
 assert.equal(calls,1);assert.equal(done.answer,answer);assert.equal(done.narration,narration);assert.equal(done.voicePresentation,'dual-v1');
 assert.deepEqual(events.filter(e=>e.type==='delta').map(e=>e.delta),[answer]);
 const saved=database.prepare("SELECT content FROM messages WHERE id=?").get(done.assistantMessageId);
 assert.equal(saved?.content,answer);assert.notEqual(saved?.content,narration);
});
