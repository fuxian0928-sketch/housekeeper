import assert from 'node:assert/strict';
import test from 'node:test';
import { requestTranscript, withVoiceDeadline } from './voice-request';

test('wake recognition expires without retry even if transport ignores abort', async () => {
 const original = globalThis.fetch;
 let calls = 0;
 try {
  globalThis.fetch = (async () => { calls++; return new Promise(() => {}); }) as typeof fetch;
  await assert.rejects(requestTranscript('wake', new AbortController().signal, { timeoutMs: 15, retries: 0 }), { name: 'TimeoutError' });
  assert.equal(calls, 1);
 } finally { globalThis.fetch = original; }
});

test('transient ASR failures retry the same audio, authorization errors do not', async () => {
 const original=globalThis.fetch; const bodies:unknown[]=[];
 try {
  globalThis.fetch=(async (_url,init)=>{bodies.push(init?.body);return bodies.length===1?Response.json({message:'busy'},{status:503}):Response.json({text:'明天开会'});}) as typeof fetch;
  assert.equal(await requestTranscript('fixture-audio',new AbortController().signal),'明天开会');
  assert.equal(bodies.length,2); assert.equal(bodies[0],bodies[1]);
  globalThis.fetch=(async ()=>Response.json({message:'key invalid'},{status:401})) as typeof fetch;
  await assert.rejects(requestTranscript('audio',new AbortController().signal),/key invalid/);
 } finally {globalThis.fetch=original;}
});
test('hung camera is bounded and receives cancellation for resource cleanup', async()=>{
 let cancelled=false;
 await assert.rejects(withVoiceDeadline(signal=>{signal.addEventListener('abort',()=>{cancelled=true});return new Promise(()=>{});},new AbortController().signal,10),{name:'TimeoutError'});
 assert.equal(cancelled,true);
});
test('parent cancellation never retries transcription', async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(requestTranscript('audio',controller.signal),{name:'AbortError'});
});
