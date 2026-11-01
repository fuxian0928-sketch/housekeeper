import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createQwenRealtimeAsr, qwenRealtimeUrl, type RealtimeAsrOptions } from './qwen-realtime-asr.js';

class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  terminated = false;
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { queueMicrotask(() => this.emit('close')); }
  terminate() { this.terminated = true; }
  event(type: string, fields = {}) { this.emit('message', Buffer.from(JSON.stringify({ type, ...fields })), false); }
}
function fixture(extra: Partial<RealtimeAsrOptions> = {}) {
  const socket = new FakeSocket();
  const controller = new AbortController();
  const asr = createQwenRealtimeAsr({ baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'test-model', apiKey: 'test-only', signal: controller.signal,
    createSocket: () => socket as unknown as ReturnType<NonNullable<RealtimeAsrOptions['createSocket']>>, ...extra });
  return { socket, controller, asr };
}
function configure(socket: FakeSocket) { socket.emit('open'); socket.event('session.updated'); }

test('manual session streams PCM in order and publishes only final transcript', async () => {
  const previews: string[] = [];
  const { socket, asr } = fixture({ onPartial: p => previews.push(p.text) });
  try {
    const pcm = Buffer.alloc(3200, 1);
    asr.append(pcm); pcm.fill(9);
    assert.equal(socket.sent.length, 0);
    configure(socket); await asr.ready;
    const done = asr.finish();
    assert.deepEqual(socket.sent.map(e => e.type), ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'session.finish']);
    assert.equal(socket.sent[0].session.turn_detection, null);
    assert.equal(Buffer.from(socket.sent[1].audio, 'base64')[0], 1);
    assert.equal(new Set(socket.sent.map(e => e.event_id)).size, 4);
    socket.event('input_audio_buffer.committed', { item_id: 'one' });
    socket.event('conversation.item.input_audio_transcription.text', { item_id: 'one', text: '新建', stash: '任' });
    socket.event('conversation.item.input_audio_transcription.text', { item_id: 'one', text: '新建', stash: '任务' });
    assert.deepEqual(previews, ['新建任', '新建任务']);
    socket.event('conversation.item.input_audio_transcription.completed', { item_id: 'one', transcript: ' 新建任务 ' });
    socket.event('session.finished');
    assert.deepEqual(await done, { text: '新建任务', final: true, audioBytes: 3200 });
    assert.equal(asr.append(Buffer.alloc(320)), false);
  } finally { asr.cancel(); }
});

test('cancel drops late cloud events and pending audio', async () => {
  let previews = 0;
  const { asr, socket, controller } = fixture({ onPartial: () => previews++ });
  asr.append(Buffer.alloc(3200)); controller.abort();
  configure(socket);
  socket.event('conversation.item.input_audio_transcription.completed', { transcript: 'stale' });
  await assert.rejects(asr.result, /ASR_CANCELLED/);
  await assert.rejects(asr.ready, /ASR_CANCELLED/);
  assert.equal(socket.sent.length, 0); assert.equal(previews, 0); assert.equal(socket.terminated, true);
});

test('official snapshot without item IDs streams previews before local commit', async () => {
  const previews: string[] = [];
  const { asr, socket } = fixture({ onPartial: p => previews.push(p.text) });
  configure(socket); await asr.ready;
  asr.append(Buffer.alloc(3200));
  socket.event('conversation.item.created', { item: { id: 'single-utterance' } });
  socket.event('conversation.item.input_audio_transcription.text', { text: '帮我', stash: '整理' });
  assert.deepEqual(previews, ['帮我整理']);
  const done = asr.finish();
  socket.event('input_audio_buffer.committed');
  socket.event('conversation.item.input_audio_transcription.completed', { transcript: '帮我整理今天的任务' });
  socket.event('session.finished');
  assert.equal((await done).text, '帮我整理今天的任务');
  socket.event('conversation.item.input_audio_transcription.text', { text: 'late' });
  assert.equal(previews.length, 1);
});

test('missing IDs do not bypass local finish and commit acknowledgement', async () => {
  for (const localFinish of [false, true]) {
    const { asr, socket } = fixture();
    configure(socket); asr.append(Buffer.alloc(3200));
    if (localFinish) asr.finish();
    socket.event('conversation.item.input_audio_transcription.completed', { transcript: 'premature' });
    await assert.rejects(asr.result, /ASR_INVALID_FINAL/);
  }
});

test('early item ID binds the connection and conflicting previews terminate it', async () => {
  const { asr, socket } = fixture();
  configure(socket); asr.append(Buffer.alloc(3200));
  socket.event('conversation.item.created', { item: { id: 'first' } });
  socket.event('conversation.item.input_audio_transcription.text', { item_id: 'other', text: 'wrong' });
  await assert.rejects(asr.result, /ASR_ITEM_MISMATCH/);
  assert.equal(socket.terminated, true);
});

test('queued audio expires instead of being uploaded after slow connection', async () => {
  let now = 100;
  const { asr, socket } = fixture({ now: () => now });
  asr.append(Buffer.alloc(3200)); now += 2100; configure(socket);
  await assert.rejects(asr.result, /ASR_AUDIO_EXPIRED/);
  assert.equal(socket.sent.some(e => e.type === 'input_audio_buffer.append'), false);
});

test('session finish without final fails and cannot authorize an action', async () => {
  const { asr, socket } = fixture();
  configure(socket); asr.append(Buffer.alloc(3200)); const done = asr.finish();
  socket.event('session.finished');
  await assert.rejects(done, /ASR_MISSING_FINAL/);
});

test('wrong item final and conflicting final are rejected', async () => {
  for (const conflicting of [false, true]) {
    const { asr, socket } = fixture();
    configure(socket); asr.append(Buffer.alloc(3200)); asr.finish();
    socket.event('input_audio_buffer.committed', { item_id: 'one' });
    if (conflicting) socket.event('conversation.item.input_audio_transcription.completed', { item_id: 'one', transcript: 'first' });
    socket.event('conversation.item.input_audio_transcription.completed', { item_id: conflicting ? 'one' : 'other', transcript: 'second' });
    await assert.rejects(asr.result, conflicting ? /ASR_CONFLICTING_FINAL/ : /ASR_INVALID_FINAL/);
  }
});

test('connection and final deadlines terminate sessions', async () => {
  const first = fixture({ connectMs: 15 });
  await assert.rejects(first.asr.ready, /ASR_CONNECT_TIMEOUT/);
  assert.equal(first.socket.terminated, true);
  const second = fixture({ finalMs: 15 });
  configure(second.socket); second.asr.append(Buffer.alloc(3200));
  await assert.rejects(second.asr.finish(), /ASR_FINAL_TIMEOUT/);
  assert.equal(second.socket.terminated, true);
});

test('bounded buffering, malformed PCM and provider errors fail safely', async () => {
  for (const kind of ['queue', 'backpressure', 'pcm', 'provider']) {
    const { asr, socket } = fixture();
    if (kind === 'queue') for (let n = 0; n < 11; n++) asr.append(Buffer.alloc(6400));
    if (kind === 'backpressure') { configure(socket); socket.bufferedAmount = 128001; asr.append(Buffer.alloc(3200)); }
    if (kind === 'pcm') asr.append(Buffer.alloc(3));
    if (kind === 'provider') socket.event('error', { error: { message: 'SECRET_KEY_PRIVATE_TRANSCRIPT' } });
    await assert.rejects(asr.result, e => e instanceof Error && /^ASR_/.test(e.message) && !e.message.includes('SECRET'));
    assert.equal(socket.terminated, true);
  }
});

test('endpoint mapping rejects untrusted destinations and query credentials', () => {
  assert.equal(qwenRealtimeUrl('https://dashscope.aliyuncs.com/compatible-mode/v1', 'asr-test'), 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=asr-test');
  for (const url of ['http://dashscope.aliyuncs.com', 'https://evil.example', 'https://dashscope.aliyuncs.com?key=secret', 'https://user:secret@dashscope.aliyuncs.com']) assert.throws(() => qwenRealtimeUrl(url, 'model'));
});

test('real websocket transport preserves authentication, PCM and final handshake', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const received: string[] = [];
  let header: string | undefined;
  let receivedBytes = 0;
  server.on('connection', (peer, request) => {
    header = request.headers.authorization;
    peer.on('message', raw => {
      const event = JSON.parse(raw.toString()); received.push(event.type);
      if (event.type === 'session.update') peer.send(JSON.stringify({ type: 'session.updated' }));
      if (event.type === 'input_audio_buffer.append') receivedBytes += Buffer.from(event.audio, 'base64').length;
      if (event.type === 'input_audio_buffer.commit') peer.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'real' }));
      if (event.type === 'session.finish') {
        peer.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'real', transcript: '传输验证' }));
        peer.send(JSON.stringify({ type: 'session.finished' }));
      }
    });
  });
  const { asr } = fixture({ createSocket: (_url, key) => new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Authorization: `Bearer ${key}` } }) });
  try {
    await asr.ready;
    for (let i = 0; i < 10; i++) asr.append(Buffer.alloc(320));
    const result = await asr.finish();
    assert.equal(result.text, '传输验证');
    assert.equal(header, 'Bearer test-only');
    assert.equal(receivedBytes, 3200);
    assert.deepEqual(received.slice(-2), ['input_audio_buffer.commit', 'session.finish']);
  } finally {
    asr.cancel();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
