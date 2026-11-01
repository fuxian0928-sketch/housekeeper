/** Provider payloads and arbitrary exception messages never become UI diagnostics. */
export function voiceFailureCode(error:unknown):string {
 const message=error instanceof Error?error.message:'';
 if(message==='VOICE_KEY_NOT_CONFIGURED')return 'VOICE_KEY_NOT_CONFIGURED';
 if(message==='TTS_AUTH_FAILED')return 'VOICE_SYNTHESIS_AUTH_FAILED';
 if(message.startsWith('TTS_')||message==='VOICE_TTS_REJECTED')return 'VOICE_SYNTHESIS_FAILED';
 if(message.startsWith('VOICE_CHAT_')||message==='VOICE_EMPTY_ANSWER'||message==='VOICE_ANSWER_LIMIT')return 'VOICE_ANSWER_FAILED';
 if(message==='PLAYBACK_SOURCE_TIMEOUT')return 'VOICE_ANSWER_TIMEOUT';
 if(message.startsWith('PLAYBACK_')||message.startsWith('VOICE_PLAYBACK_'))return 'VOICE_PLAYBACK_FAILED';
 return 'VOICE_RESPONSE_FAILED';
}
