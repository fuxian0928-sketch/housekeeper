import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createQwenRealtimeTts, type RealtimeTtsOptions } from './qwen-realtime-tts.js';

class Socket extends EventEmitter {
  sent: any[] = []; bufferedAmount = 0; terminated = false; paused = false; pauses = 0;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { queueMicrotask(() => this.emit('close')); }
  terminate() { this.terminated = true; }
  pause() { this.paused = true; this.pauses++; }
  resume() { this.paused = false; }
  event(type: string, fields = {}) { this.emit('message', Buffer.from(JSON.stringify({ type, ...fields })), false); }
}
function fixture(extra: Partial<RealtimeTtsOptions> = {}) {
  const socket = new Socket(), controller = new AbortController();
  const tts = createQwenRealtimeTts({ baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen3-tts-flash-realtime', voice: 'Cherry', apiKey: 'test-only', signal: controller.signal,
    createSocket: () => socket as any, ...extra });
  const configure = () => { socket.emit('open'); socket.event('session.updated', { session: { sample_rate: 16000, response_format: 'pcm', mode: 'server_commit' } }); };
  return { socket, controller, tts, configure };
}
test('negotiates PCM16k, streams before text finishes and drains after session finish', async () => {
  const f = fixture(); f.configure(); await f.tts.ready;
  try {
    const reader = f.tts.audio[Symbol.asyncIterator]();
    assert.equal(f.tts.append('主人，我在。'), true);
    const pending = reader.next(); const pcm = Buffer.alloc(8000, 7);
    f.socket.event('response.audio.delta', { delta: pcm.toString('base64') });
    assert.deepEqual((await pending).value, pcm.subarray(0, 6400));
    assert.equal(f.tts.append('请说吧。'), true); assert.equal(f.tts.finish(), true);
    f.socket.event('response.done', { response: { status: 'completed' } });
    f.socket.event('session.finished');
    assert.deepEqual((await reader.next()).value, pcm.subarray(6400));
    assert.equal((await reader.next()).done, true);
    assert.deepEqual(f.socket.sent.map(e => e.type), ['session.update', 'input_text_buffer.append', 'input_text_buffer.append', 'session.finish']);
    assert.equal(f.socket.sent[0].session.sample_rate, 16000);
  } finally { f.tts.cancel(); }
});
test('cancellation clears buffered speech even after cloud completion', async () => {
  const f = fixture(); f.configure(); await f.tts.ready;
  f.tts.append('测试'); f.tts.finish(); f.socket.event('response.audio.delta', { delta: Buffer.alloc(640).toString('base64') }); f.socket.event('session.finished');
  f.controller.abort(); await assert.rejects(f.tts.audio[Symbol.asyncIterator]().next());
  assert.equal(f.socket.terminated, true);
});
test('cancellation wakes a consumer waiting for cloud audio', async () => {
  const f = fixture(); f.configure(); await f.tts.ready; f.tts.append('测试');
  const pending = f.tts.audio[Symbol.asyncIterator]().next(); f.controller.abort(); await assert.rejects(pending, /CANCELLED|abort/i);
});
test('a fast 24-second cloud burst waits for slower playback without failing', async () => {
  const f = fixture(); f.configure(); await f.tts.ready;
  try {
    f.tts.append('较长的回答'); f.tts.finish();
    const writer = (async () => {
      for (let i = 0; i < 12; i++) {
        while (f.socket.paused) await delay(0);
        f.socket.event('response.audio.delta', { delta: Buffer.alloc(64000, i).toString('base64') });
      }
      f.socket.event('session.finished');
    })();
    let bytes = 0;
    for await (const pcm of f.tts.audio) bytes += pcm.length;
    await writer;
    assert.equal(bytes, 768000);
    assert.equal(f.socket.terminated, false);
    assert.ok(f.socket.pauses > 0);
  } finally { f.tts.cancel(); }
});
test('a 60-second answer streams through bounded queue without slowing its first audio', async () => {
  const f = fixture(); f.configure(); await f.tts.ready;
  try {
    f.tts.append('长回复'); f.tts.finish();
    let first = false;
    const reader = (async () => { let bytes = 0; for await (const pcm of f.tts.audio) { first = true; bytes += pcm.length; } return bytes; })();
    for (let i = 0; i < 30; i++) {
      while (f.socket.paused) await delay(0);
      f.socket.event('response.audio.delta', { delta: Buffer.alloc(64000, i).toString('base64') });
      if (i === 0) { await delay(0); assert.equal(first, true); }
    }
    f.socket.event('session.finished');
    assert.equal(await reader, 1_920_000);
    assert.ok(f.socket.pauses > 0);
  } finally { f.tts.cancel(); }
});
test('ongoing synthesis renews the inactivity deadline, while a stalled provider still fails', async () => {
  const moving = fixture({ totalMs: 100 }); moving.configure(); await moving.tts.ready;
  try {
    moving.tts.append('持续生成的回答'); moving.tts.finish();
    const reader = (async () => { let bytes = 0; for await (const pcm of moving.tts.audio) bytes += pcm.length; return bytes; })();
    for (let i = 0; i < 4; i++) {
      await delay(55);
      moving.socket.event('response.audio.delta', { delta: Buffer.alloc(3200).toString('base64') });
    }
    moving.socket.event('session.finished');
    assert.equal(await reader, 12800);
  } finally { moving.tts.cancel(); }

  const stalled = fixture({ totalMs: 20 }); stalled.configure(); await stalled.tts.ready;
  try {
    stalled.tts.append('停滞'); stalled.tts.finish();
    await assert.rejects(stalled.tts.audio[Symbol.asyncIterator]().next(), /TTS_TOTAL_TIMEOUT/);
  } finally { stalled.tts.cancel(); }
});
test('real WebSocket receive backpressure streams an eighty-second answer', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('TEST_SOCKET_ADDRESS');
  const delta = Buffer.alloc(64000, 5).toString('base64');
  server.on('connection', peer => peer.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'session.update') peer.send(JSON.stringify({ type: 'session.updated', session: { sample_rate: 16000, response_format: 'pcm', mode: 'server_commit' } }));
    if (message.type === 'session.finish') {
      for (let i = 0; i < 40; i++) peer.send(JSON.stringify({ type: 'response.audio.delta', delta }));
      peer.send(JSON.stringify({ type: 'session.finished' }));
    }
  }));
  const controller = new AbortController();
  let pauses = 0;
  const tts = createQwenRealtimeTts({ baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen3-tts-flash-realtime', voice: 'Cherry', apiKey: 'test-only', signal: controller.signal,
    createSocket: () => {
      const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
      const pause = client.pause.bind(client);
      client.pause = () => { pauses++; pause(); };
      return client;
    } });
  try {
    await tts.ready; assert.equal(tts.append('长回复'), true); assert.equal(tts.finish(), true);
    let bytes = 0;
    for await (const pcm of tts.audio) { bytes += pcm.length; await delay(1); }
    assert.equal(bytes, 2_560_000);
    assert.ok(pauses > 0);
  } finally {
    controller.abort();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
test('format mismatch refuses audio instead of playing at the wrong speed', async () => {
  const f = fixture(); f.socket.event('session.updated', { session: { sample_rate: 24000, response_format: 'pcm', mode: 'server_commit' } });
  await assert.rejects(f.tts.ready, /FORMAT_MISMATCH/); assert.equal(f.socket.terminated, true);
});
test('malformed, overflowing and failed responses abort with sanitized errors', async () => {
  for (const kind of ['bad-base64', 'overflow', 'failed', 'close']) {
    const f = fixture(); f.configure(); await f.tts.ready; f.tts.append('测试');
    if (kind === 'bad-base64') f.socket.event('response.audio.delta', { delta: 'secret-invalid' });
    if (kind === 'overflow') for (let i = 0; i < 16; i++) f.socket.event('response.audio.delta', { delta: Buffer.alloc(64000).toString('base64') });
    if (kind === 'failed') f.socket.event('response.done', { response: { status: 'failed', message: 'private' } });
    if (kind === 'close') f.socket.emit('close');
    await assert.rejects(f.tts.audio[Symbol.asyncIterator]().next(), /^Error: TTS_/); assert.equal(f.socket.terminated, true);
  }
});
test('connection deadline and unsupported legacy models are explicit failures', async () => {
  const f = fixture({ connectMs: 10 }); await assert.rejects(f.tts.ready, /CONNECT_TIMEOUT/);
  assert.throws(() => fixture({ model: 'qwen-tts-realtime' }), /UNSUPPORTED_MODEL/);
});

test('TTS stream feeds the native player before synthesis ends and waits for device receipt', async () => {
  const { NativePlayback } = createRequire(import.meta.url)('../../electron/native-playback.cjs');
  const worker = new EventEmitter() as EventEmitter & { playback(packet: any): boolean };
  const packets: any[] = [];
  worker.playback = packet => { packets.push({ ...packet, ...(packet.pcm ? { pcm: Buffer.from(packet.pcm) } : {}) }); return true; };
  const f = fixture(); f.configure(); await f.tts.ready; f.tts.append('测试');
  const key = { generation: 1, audioGeneration: 1, turn: 1 };
  let settled = false;
  const playing = new NativePlayback(worker).playStream(key, f.tts.audio, f.controller.signal).then((result: any) => { settled = true; return result; });
  try {
    f.socket.event('response.audio.delta', { delta: Buffer.alloc(3200, 5).toString('base64') }); await delay(10);
    assert.equal(packets.some(p => p.type === 'playback-audio'), true);
    assert.equal(packets.some(p => p.type === 'playback-end'), false);
    f.tts.finish(); f.socket.event('session.finished'); await delay(10);
    assert.equal(settled, false); assert.equal(packets.at(-1).type, 'playback-end');
    worker.emit('event', { ...key, type: 'playback-submitted', renderedFrames: 10 });
    assert.equal((await playing).renderedFrames, 10);
  } finally { f.controller.abort(); await playing.catch(() => {}); }
});


test('speech rate is negotiated, defaults to one, and invalid values never open a socket', async () => {
  for (const speechRate of [undefined, 0.5, 1.25, 2]) {
    const f = fixture({ speechRate });
    try { f.configure(); await f.tts.ready; assert.equal(f.socket.sent[0].session.speech_rate, speechRate ?? 1); }
    finally { f.tts.cancel(); }
  }
  for (const speechRate of [NaN, Infinity, 0.49, 2.01]) {
    let opened = false;
    assert.throws(() => fixture({ speechRate, createSocket: () => { opened = true; throw Error('unexpected'); } }), /INVALID_SPEECH_RATE/);
    assert.equal(opened, false);
  }
});

test('handshake authorization failure is distinct without exposing response content',async()=>{
 for(const statusCode of [401,403,429,503]){
  const f=fixture();let drained=false;
  const ready=assert.rejects(f.tts.ready,statusCode===401||statusCode===403?/TTS_AUTH_FAILED/:/TTS_HANDSHAKE_FAILED/);
  f.socket.emit('unexpected-response',{}, {statusCode,resume(){drained=true;},body:'private-provider-detail'});
  await ready;assert.equal(drained,true);assert.equal(f.socket.terminated,true);
 }
});
