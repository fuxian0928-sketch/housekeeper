const test = require('node:test'), assert = require('node:assert/strict');
const { readVoiceTiming, sanitizeVoiceTiming } = require('../../electron/voice-timing-config.cjs');
const { VoiceWorkerSupervisor } = require('../../electron/voice-worker-supervisor.cjs');
test('old settings migrate to defaults; partial edits preserve unrelated timing', () => {
  assert.deepEqual(readVoiceTiming({}), { voiceContinuousEnabled: true, voiceMinSpeechMs: 120, voiceMaxUtteranceSeconds: 30, voiceIdleSeconds: 300, voiceEndSilenceMs: 1000, voiceBargeInEnabled: true });
  assert.deepEqual(sanitizeVoiceTiming({ voiceIdleSeconds: 600 }), { voiceIdleSeconds: 600 });
  assert.deepEqual(readVoiceTiming({ voiceIdleSeconds: NaN, voiceEndSilenceMs: '500' }), { voiceContinuousEnabled: true, voiceMinSpeechMs: 120, voiceMaxUtteranceSeconds: 30, voiceIdleSeconds: 300, voiceEndSilenceMs: 1000, voiceBargeInEnabled: true });
  assert.deepEqual(readVoiceTiming({ voiceIdleSeconds: -1, voiceEndSilenceMs: 9999 }), { voiceContinuousEnabled: true, voiceMinSpeechMs: 120, voiceMaxUtteranceSeconds: 30, voiceIdleSeconds: 30, voiceEndSilenceMs: 3000, voiceBargeInEnabled: true });
});
test('supervisor refuses invalid settings or a stopped process before writing', () => {
  const worker = new VoiceWorkerSupervisor({ executable: process.execPath, args: [] });
  const valid = { voiceIdleSeconds: 600, voiceEndSilenceMs: 1500, voiceBargeInEnabled: true }, packets = [];
  assert.equal(worker.configureTiming(valid), false);
  worker.current = { ready: true, stopping: false, child: { stdin: { destroyed: false, writableLength: 0, write: data => packets.push(JSON.parse(data)) } } };
  assert.equal(worker.configureTiming({ ...valid, voiceIdleSeconds: Infinity }), false);
  assert.equal(worker.configureTiming({ ...valid, voiceEndSilenceMs: 299 }), false);
  for (const value of [4,31,Infinity,'15',15.5]) assert.equal(worker.configureTiming({...valid,voiceMaxUtteranceSeconds:value}),false);
  assert.equal(worker.configureTiming({...valid,voiceMaxUtteranceSeconds:15}),true);
  assert.equal(packets.pop().maxUtteranceSeconds,15);
  for(const value of [49,501,NaN,'120',120.5]) assert.equal(worker.configureTiming({...valid,voiceMinSpeechMs:value}),false);
  assert.equal(worker.configureTiming({...valid,voiceMinSpeechMs:250}),true);assert.equal(packets.pop().minSpeechMs,250);
  assert.equal(worker.configureTiming(valid), true);
  assert.equal(worker.configureTiming({ ...valid, voiceBargeInEnabled: 'false' }), false);
  assert.equal(worker.configureTiming({ ...valid, voiceBargeInEnabled: false }), true);
  assert.equal(packets.pop().bargeInEnabled, false);
  assert.deepEqual(packets, [{ type: 'configure-timing', ownerManaged:true, continuousEnabled:true, minSpeechMs: 120, maxUtteranceSeconds: 30, idleSeconds: 600, endSilenceMs: 1500, bargeInEnabled: true }]);
});

test('interruption toggle accepts booleans only', () => {
  assert.equal(readVoiceTiming({voiceBargeInEnabled:false}).voiceBargeInEnabled,false);
  for (const value of ['false',0,null]) assert.equal(readVoiceTiming({voiceBargeInEnabled:value}).voiceBargeInEnabled,true);
});

test('single turn setting validates and crosses the supervisor protocol',()=>{
 const packets=[],worker=new VoiceWorkerSupervisor({executable:process.execPath,args:[]});worker.current={ready:true,child:{stdin:{destroyed:false,writableLength:0,write:line=>packets.push(JSON.parse(line))}}};
 const config=readVoiceTiming({voiceContinuousEnabled:false});assert.equal(config.voiceContinuousEnabled,false);assert.equal(worker.configureTiming(config),true);assert.equal(packets[0].continuousEnabled,false);
 for(const value of ['false',0,null])assert.equal(worker.configureTiming({...config,voiceContinuousEnabled:value}),false);
});
