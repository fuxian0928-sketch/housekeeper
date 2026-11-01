const { validFarewell } = require('./voice-farewell-config.cjs');
// Save-time validation is strict. Legacy disk readers retain their migration rules.
const numberFields = Object.freeze({
 voiceEchoDelayMs: ['回声延迟',0,250,true],
 voiceMinSpeechMs: ['最短有效人声',50,500,true],
 voiceMaxUtteranceSeconds: ['单次发言上限',5,30,true],
 voiceIdleSeconds: ['待机等待',30,1800,true],
 voiceEndSilenceMs: ['说话结束等待',300,3000,true],
 voiceProgressFirstMs: ['首次进度提示',1000,5000,true],
 voiceProgressIntervalMs: ['进度提示间隔',5000,20000,true],
 voiceSpeechRate: ['播报速度',0.5,2,false],
 speechVolume: ['播报音量',0,100,true],
 wakeWordThreshold: ['唤醒严格程度',0.45,0.95,false]
});
const enums = Object.freeze({voiceProgressMode:['off','concise','detailed'],voicePrefetchAttempts:[1,2],voiceRoutingMode:['auto','work','life']});
function validateNativeVoiceChanges(changes) {
 if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw Error('语音设置未保存：配置格式无效。');
 if(Object.hasOwn(changes,'voiceFarewellText') && !validFarewell(changes.voiceFarewellText)) throw Error('语音设置未保存：退下提示请填写 1–120 个字，不支持换行。');
 for (const [key,[label,min,max,integer]] of Object.entries(numberFields)) {
  if (!Object.hasOwn(changes,key)) continue;
  const value=changes[key];
  if (!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value))) throw Error(`语音设置未保存：${label}必须为 ${min}–${max} 范围内的${integer?'整数':'数值'}。`);
 }
 if(Object.hasOwn(changes,'voiceSpeechRate') && Math.abs(changes.voiceSpeechRate*100-Math.round(changes.voiceSpeechRate*100))>1e-8) throw Error('语音设置未保存：播报速度最多保留两位小数。');
 for (const key of ['voiceContinuousEnabled','voiceNoiseSuppression','voiceAutoGain','voiceBargeInEnabled','voicePrefetchEnabled','wakeWordEnabled']) if(Object.hasOwn(changes,key)&&typeof changes[key]!=='boolean') throw Error('语音设置未保存：开关值必须为开启或关闭。');
 for (const [key,values] of Object.entries(enums)) if(Object.hasOwn(changes,key)&&!values.includes(changes[key])) throw Error('语音设置未保存：请选择有效的对话模式、提示方式或检索次数。');
 if(Object.hasOwn(changes,'wakeWord')) {
  try {require('./native-wake-keywords.cjs').wakeDefinition(changes);} catch {throw Error('唤醒词未保存：请使用2–12个汉字或字母E。');}
 }
}
module.exports={validateNativeVoiceChanges};
