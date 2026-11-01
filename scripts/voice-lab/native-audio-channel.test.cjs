const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeAudioChannel } = require('../../electron/native-audio-channel.cjs');
const packet = (at, sequence=0) => ({generation:1,turn:1,sequence,capturedAtMs:at,pcm:Buffer.alloc(320).toString('base64')});

test('clock mapping is conservative and frozen per turn', () => {
  let now=1000; const received=[];
  const channel=new NativeAudioChannel(p=>received.push(p),()=>now);
  channel.ping('1'); now=1020; assert.equal(channel.synchronize('1',5010),true);
  channel.receive(packet(5000),2);
  assert.equal(received[0].capturedAt,925);
  channel.ping('2');now=1030;channel.synchronize('2',5030);
  channel.receive(packet(5010,1),2);
  assert.equal(received[1].capturedAt,935);
  assert.equal(received[1].workerGeneration,2);
});
test('unsynchronized, stale, malformed and delayed audio never reaches consumer', () => {
  let now=1000, count=0;
  const channel=new NativeAudioChannel(()=>count++,()=>now);
  assert.throws(()=>channel.receive(packet(1),1),/CLOCK/);
  channel.ping('1');now+=200;assert.equal(channel.synchronize('1',5000),false);
  channel.ping('2');assert.equal(channel.synchronize('other',5000),false);
  assert.equal(channel.synchronize('2',5000),true);
  assert.throws(()=>channel.receive(packet(1000),1),/EXPIRED/);
  assert.throws(()=>channel.receive({...packet(5000),pcm:'invalid'},1),/INVALID/);
  now+=4100;assert.throws(()=>channel.receive(packet(9000),1),/CLOCK/);
  assert.equal(count,0);
});
