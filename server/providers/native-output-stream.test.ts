import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeOutputStream } from './native-output-stream.js';
import { setTimeout as delay } from 'node:timers/promises';

function setup() {
  let resolve!: (result: IteratorResult<Buffer>) => void;
  let retired = false, starts = 0, current = true, returned = false;
  const packets: Array<{kind:string;bytes:number}>=[];
  const source = { [Symbol.asyncIterator]() { return this; }, next() { return new Promise<IteratorResult<Buffer>>(done => { resolve = done; }); }, return() { returned = true; return Promise.resolve({ done: true as const, value: undefined }); } };
  const pcm = Buffer.alloc(96000, 1), controller = new AbortController();
  const output = nativeOutputStream(source, { finish() { retired = true; }, next() {
    return retired ? null : { pcm, current: () => current && !retired, started() { starts++; return true; } };
  } }, controller.signal,(kind,bytes)=>packets.push({kind,bytes}));
  return { output, controller, pcm, packets, deliver: (value: Buffer) => resolve({ done: false, value }), end: () => resolve({ done: true, value: undefined }), expire: () => { current = false; }, state: () => ({ starts, retired, returned }) };
}

test('answer preempts a three-second progress clip at next packet without mixing samples', async () => {
  const f = setup(); const first = await f.output.next(); assert.equal(first.value!.length,3200);
  assert.ok(first.value!.every((n: number)=>n===1)); assert.equal(f.state().starts,1);
  f.deliver(Buffer.alloc(320,2)); await delay(0);
  const next = await f.output.next(); assert.deepEqual(next.value,Buffer.alloc(320,2));
  assert.equal(f.state().retired,true); assert.equal(f.pcm[0],1);
  assert.deepEqual(f.packets,[{kind:'progress',bytes:3200},{kind:'answer',bytes:320}]);
  const pending=f.output.next(); await delay(0); f.end(); assert.equal((await pending).done,true);
});

test('expired progress does not resume while waiting for answer', async () => {
  const f=setup(); await f.output.next(); f.expire();
  const pending=f.output.next(); await delay(10); f.deliver(Buffer.alloc(320,3));
  assert.deepEqual((await pending).value,Buffer.alloc(320,3)); assert.equal(f.state().starts,1);
  await f.output.return(undefined);
});

test('abort releases a stalled producer and prevents late PCM from playing', async () => {
  const f=setup(); await f.output.next(); f.expire();
  const pending=f.output.next(); f.controller.abort(); await assert.rejects(pending);
  f.deliver(Buffer.alloc(320,4)); assert.equal(f.state().returned,true); assert.equal(f.state().retired,true);
});

test('malformed cached audio is skipped without changing the answer', async () => {
  let starts=0;
  const output=nativeOutputStream({async *[Symbol.asyncIterator]() {await delay(30); yield Buffer.alloc(320,9);}},
    {finish(){},next(){return {pcm:Buffer.alloc(96001),current:()=>true,started(){starts++;return true;}};}},new AbortController().signal);
  const result=[]; for await(const chunk of output)result.push(chunk);
  assert.equal(starts,0); assert.deepEqual(result,[Buffer.alloc(320,9)]);
});
