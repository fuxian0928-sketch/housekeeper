const DEFAULT_VOICE_PROCESSING=Object.freeze({voiceNoiseSuppression:false,voiceAutoGain:false,voiceEchoDelayMs:44});
function sanitizeVoiceProcessing(value){const result={};for(const key of ['voiceNoiseSuppression','voiceAutoGain'])if(typeof value?.[key]==='boolean')result[key]=value[key];if(Number.isInteger(value?.voiceEchoDelayMs)&&value.voiceEchoDelayMs>=0&&value.voiceEchoDelayMs<=250)result.voiceEchoDelayMs=value.voiceEchoDelayMs;return result;}
function readVoiceProcessing(value){return {...DEFAULT_VOICE_PROCESSING,...sanitizeVoiceProcessing(value)};}
function voiceProcessingArgs(value){const config=readVoiceProcessing(value);return ['--echo-delay-ms',String(config.voiceEchoDelayMs),...(config.voiceNoiseSuppression?['--noise-suppression']:[]),...(config.voiceAutoGain?['--auto-gain']:[])];}
module.exports={DEFAULT_VOICE_PROCESSING,sanitizeVoiceProcessing,readVoiceProcessing,voiceProcessingArgs};
