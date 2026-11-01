// Public, fixed text only. Never display provider error strings.
function voiceStatusMessage(previous,event){
 if(event.code==='VOICE_DEVICE_RECOVERY_EXHAUSTED')return '音频设备重连失败。请检查设备连接，然后重新开启语音唤醒。';
 if(event.type==='recovering')return '音频设备连接中断，正在重连。请检查麦克风和音箱连接。';
 if(['recovered','finished','responding','speaking'].includes(event.type))return null;
 if(event.type!=='failed')return previous;
 const messages={
  ASR_AUTH_FAILED:'语音识别认证被拒绝，请在模型连接中检查密钥及模型权限。',
  ASR_AUDIO_TOO_SHORT:'这次录音太短，没有完成识别，请再完整说一次。',
  ASR_CONNECT_TIMEOUT:'连接语音识别服务超时，本轮已停止。请检查网络后再说一次。',
  ASR_FINAL_TIMEOUT:'等待识别结果超时，本轮已停止，请再说一次。',
  ASR_TOTAL_TIMEOUT:'本轮识别超过等待上限，已停止，请分段再说一次。',
  ASR_AUDIO_EXPIRED:'音频传输延迟过大，已丢弃本轮旧录音，请检查网络后再说一次。',
  ASR_SEND_BACKPRESSURE:'语音上传拥堵，本轮已停止，请检查网络后再说一次。',
  VOICE_SYNTHESIS_AUTH_FAILED:'语音合成认证被拒绝，请检查合成密钥及模型权限；工作操作请先核对执行记录。',
  ASR_AUDIO_DISCONTINUITY:'麦克风音频中断，本轮未继续识别。请检查设备后重新说一次。',
  ASR_AUDIO_REJECTED:'本轮录音未能送达识别服务，请检查设备和网络后再试。',
  VOICE_KEY_NOT_CONFIGURED:'语音凭证不可用，请在设置中检查本机语音密钥。',
  VOICE_SYNTHESIS_FAILED:'语音合成未完成，请检查合成连接；工作操作请先核对执行记录，避免重复执行。',
  VOICE_ANSWER_FAILED:'本轮回答未完成，请检查对话模型连接；工作操作请先核对执行记录。',
  VOICE_PLAYBACK_FAILED:'声音播放未完成，请检查音箱和输出设备；工作操作请先核对执行记录。',
  VOICE_ANSWER_TIMEOUT:'等待语音回复超时，已停止本轮播放。涉及工作操作时，请先核对执行记录。',
  VOICE_TURN_TIMEOUT:'本轮等待超时，已停止处理。请重新说一次；工作操作请先核对执行记录。',
  VOICE_CONTROL_REJECTED:'语音会话未能恢复，请在设置中重新开启语音唤醒。',
  VOICE_DEVICE_FAILED:'音频设备连接异常，请检查麦克风和音箱。'
 };
 if(Object.prototype.hasOwnProperty.call(messages,event.code))return messages[event.code];
 if(typeof event.code==='string'&&event.code.startsWith('ASR_'))return '语音识别未完成，请检查网络和语音识别连接后再试。';
 return '本轮语音未完成，请重试；涉及任务或文档时，请先核对执行记录。';
}
// Error/recovery events carry no audible output. They must not use the
// notification animation, which visually claims the assistant is speaking.
function voiceStatusState(event){
 return ({wake:'waking',listening:'listening',responding:'thinking',speaking:'speaking'})[event.type] ?? 'idle';
}
module.exports={voiceStatusMessage,voiceStatusState};
