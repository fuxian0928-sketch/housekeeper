import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { registerRemoteApiProxy } from './remote-api-proxy.js';
import type { SettingsService } from '../domain/settings/settings-service.js';
import type { CentralSyncClient } from './central-sync-client.js';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('real proxy disconnect cancels upstream before headers and during streaming', { timeout: 8000 }, async () => {
  const oldUrl = process.env.AI_SECRETARY_REMOTE_URL;
  const oldToken = process.env.AI_SECRETARY_REMOTE_TOKEN;
  let began!: () => void;
  let disconnected!: () => void;
  const upstream = createServer((request, response) => {
    if (request.url === '/api/settings') { response.end(JSON.stringify({ hasApiKey: true, hasRetrievalApiKey: true, hasWebSearchApiKey: true })); return; }
    if (request.url === '/api/complete') { response.end('complete'); return; }
    response.once('close', () => disconnected());
    if (request.url === '/api/stream') { response.setHeader('content-type', 'text/event-stream'); response.write('data: first\n\n'); }
    began();
  });
  const app = express();
  const proxy = createServer(app);
  try {
    process.env.AI_SECRETARY_REMOTE_URL = await listen(upstream);
    delete process.env.AI_SECRETARY_REMOTE_TOKEN;
    registerRemoteApiProxy(app, {} as SettingsService, {} as CentralSyncClient);
    const url = await listen(proxy);
    for (const path of ['/api/speech/synthesize', '/api/stream']) {
      const started = new Promise<void>(resolve => { began = resolve; });
      const closed = new Promise<void>(resolve => { disconnected = resolve; });
      const controller = new AbortController();
      const pending = fetch(url + path, { signal: controller.signal });
      void pending.catch(() => {});
      await started;
      if (path === '/api/stream') {
        const response = await pending;
        const reader = response.body!.getReader();
        assert.equal((await reader.read()).done, false);
        controller.abort();
        await assert.rejects(reader.read());
      } else {
        controller.abort();
        await assert.rejects(pending);
      }
      await closed;
    }
    assert.equal(await (await fetch(url + '/api/complete')).text(), 'complete');
  } finally {
    if (oldUrl === undefined) delete process.env.AI_SECRETARY_REMOTE_URL; else process.env.AI_SECRETARY_REMOTE_URL = oldUrl;
    if (oldToken === undefined) delete process.env.AI_SECRETARY_REMOTE_TOKEN; else process.env.AI_SECRETARY_REMOTE_TOKEN = oldToken;
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
  }
});

test('remote chat and continuation use the trusted desktop identity without sending its proof to unrelated APIs', {timeout:8000}, async()=>{
  const oldUrl=process.env.AI_SECRETARY_REMOTE_URL,oldToken=process.env.AI_SECRETARY_REMOTE_TOKEN;
  const trusted=globalThis as typeof globalThis&{__AI_SECRETARY_DEVICE_CONTEXT__?:()=>Record<string,unknown>};const previous=trusted.__AI_SECRETARY_DEVICE_CONTEXT__;
  const upstream=createServer(async(request,response)=>{if(request.url==='/api/settings'){response.end(JSON.stringify({hasApiKey:true,hasRetrievalApiKey:true,hasWebSearchApiKey:true}));return;}let body='';for await(const chunk of request)body+=chunk;response.setHeader('content-type','application/json');response.end(JSON.stringify({body:JSON.parse(body||'{}')}));});
  const app=express();app.use(express.json());const proxy=createServer(app);
  try{
    process.env.AI_SECRETARY_REMOTE_URL=await listen(upstream);delete process.env.AI_SECRETARY_REMOTE_TOKEN;
    trusted.__AI_SECRETARY_DEVICE_CONTEXT__=()=>({deviceId:'trusted-device',interactionContext:{focus:{kind:'page',id:'tasks',title:'待办事项'}},computerCaller:{deviceId:'trusted-device',token:'local-proof-fixture'}});
    registerRemoteApiProxy(app,{} as SettingsService,{} as CentralSyncClient);const root=await listen(proxy);
    for(const path of ['/api/chat/stream','/api/agent/runs','/api/agent/runs/run-one/continue','/api/actions/action-one/confirm','/api/actions/action-one/cancel','/api/knowledge/documents']){
      const response=await fetch(root+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'测试',deviceId:'forged-device'})});assert.equal(response.status,200);const {body}=await response.json();
      if(path==='/api/knowledge/documents'){assert.equal(body.deviceId,'forged-device');assert.equal(body.computerCaller,undefined);assert.equal(body.interactionContext,undefined);}
      else{assert.equal(body.deviceId,'trusted-device');assert.equal(body.computerCaller.token,'local-proof-fixture');assert.equal(body.interactionContext.focus.id,'tasks');}
    }
  }finally{
    trusted.__AI_SECRETARY_DEVICE_CONTEXT__=previous;
    if(oldUrl===undefined)delete process.env.AI_SECRETARY_REMOTE_URL;else process.env.AI_SECRETARY_REMOTE_URL=oldUrl;
    if(oldToken===undefined)delete process.env.AI_SECRETARY_REMOTE_TOKEN;else process.env.AI_SECRETARY_REMOTE_TOKEN=oldToken;
    proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise<void>(resolve=>proxy.close(()=>resolve())),new Promise<void>(resolve=>upstream.close(()=>resolve()))]);
  }
});
