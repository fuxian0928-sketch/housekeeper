const test=require('node:test'),assert=require('node:assert/strict');
const {voiceStatusMessage:message,voiceStatusState:phase}=require('../../electron/voice-status-message.cjs');

test('a playback error or device recovery stops the speaking animation immediately',()=>{
 assert.equal(phase({type:'speaking'}),'speaking');
 for(const type of ['failed','recovering','recovered','finished','standby'])assert.equal(phase({type}),'idle');
 assert.equal(phase({type:'responding'}),'thinking');
 assert.match(message(null,{type:'failed',code:'VOICE_PLAYBACK_FAILED'}),/播放未完成/);
});
test('failures explain the stage without leaking provider text; passive events do not erase errors',()=>{
 for(const [code,match] of [['ASR_TIMEOUT',/语音识别/],['VOICE_SYNTHESIS_FAILED',/语音合成/],['VOICE_ANSWER_FAILED',/对话模型/],['VOICE_PLAYBACK_FAILED',/输出设备/],['VOICE_TURN_TIMEOUT',/执行记录/]]){
  const text=message(null,{type:'failed',code,detail:'PRIVATE'});assert.match(text,match);assert.ok(!text.includes('PRIVATE'));
  assert.equal(message(text,{type:'listening'}),text);assert.equal(message(text,{type:'standby'}),text);
  assert.equal(message(text,{type:'finished'}),null);
 }
 assert.ok(!message(null,{type:'failed',code:'PRIVATE_API_SECRET'}).includes('PRIVATE'));
 assert.match(message(null,{type:'failed',code:'VOICE_DEVICE_RECOVERY_EXHAUSTED'}),/重连失败/);
});

test('recognition guidance distinguishes credentials, short input, timeout and expired audio',()=>{
 for(const [code,match] of [['ASR_AUTH_FAILED',/认证被拒绝/],['ASR_AUDIO_TOO_SHORT',/录音太短/],['ASR_CONNECT_TIMEOUT',/连接.*超时/],['ASR_FINAL_TIMEOUT',/识别结果超时/],['ASR_TOTAL_TIMEOUT',/分段/],['ASR_AUDIO_EXPIRED',/丢弃.*旧录音/],['ASR_SEND_BACKPRESSURE',/上传拥堵/]])assert.match(message(null,{type:'failed',code}),match);
});
test('post-Agent failures never imply work has not run or encourage blind retries',()=>{
 for(const code of ['VOICE_SYNTHESIS_FAILED','VOICE_SYNTHESIS_AUTH_FAILED','VOICE_ANSWER_FAILED','VOICE_PLAYBACK_FAILED']){
  const text=message(null,{type:'failed',code,detail:'private-provider-detail'});
  assert.match(text,/核对执行记录/);assert.ok(!text.includes('private-provider-detail'));
 }
});
