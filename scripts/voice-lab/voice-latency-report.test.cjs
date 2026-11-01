const test=require('node:test'),assert=require('node:assert/strict');
const {voiceLatencyReport}=require('../../electron/voice-latency-report.cjs');
test('latency projection reports overlapping stages without summing them or exposing text',()=>{
 const row={startedAt:'2026-09-20T00:00:00.000Z',text:'PRIVATE',marks:{'turn-start':0,'turn-end':1000,'asr-final':1200,'tts-start':1210,'answer-start':1215,'first-answer-text':1300,'tts-ready':1450,'first-sentence':1460,'first-answer-pcm':1600,'playback-complete':1900},secret:'PRIVATE'};
 assert.deepEqual(voiceLatencyReport([row]),[{startedAt:row.startedAt,status:'submitted',asrWaitMs:200,ttsConnectMs:240,answerFirstMs:85,ttsFirstMs:140,responseWaitMs:600}]);
 assert.ok(!JSON.stringify(voiceLatencyReport([row])).includes('PRIVATE'));
});
test('missing and reversed marks are unavailable, cancellation/failure never imply audibility',()=>{
 const rows=voiceLatencyReport([{marks:{}},{marks:{'turn-end':100,'asr-final':50,'turn-cancelled':200}},{marks:{'playback-complete':300,'turn-failed':301}}]);
 assert.equal(rows[0].status,'failed');assert.equal(rows[1].status,'cancelled');assert.equal(rows[1].asrWaitMs,null);assert.equal(rows[2].status,'pending');assert.equal(rows[2].ttsFirstMs,null);
 assert.equal(voiceLatencyReport(Array.from({length:50},()=>({marks:{}}))).length,10);
});
