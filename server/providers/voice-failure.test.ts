import test from 'node:test';import assert from 'node:assert/strict';import {voiceFailureCode} from './voice-failure.js';
test('public response failure codes retain stage and strip arbitrary exception details',()=>{
 for(const [raw,expected] of [['TTS_CONNECT_TIMEOUT','VOICE_SYNTHESIS_FAILED'],['VOICE_TTS_REJECTED','VOICE_SYNTHESIS_FAILED'],['VOICE_CHAT_HTTP_FAILED','VOICE_ANSWER_FAILED'],['VOICE_EMPTY_ANSWER','VOICE_ANSWER_FAILED'],['VOICE_PLAYBACK_REJECTED','VOICE_PLAYBACK_FAILED'],['PLAYBACK_SOURCE_TIMEOUT','VOICE_ANSWER_TIMEOUT'],['PLAYBACK_SEND_FAILED','VOICE_PLAYBACK_FAILED'],['secret credential','VOICE_RESPONSE_FAILED']])assert.equal(voiceFailureCode(Error(raw)),expected);
 assert.equal(voiceFailureCode({message:'TTS_SECRET'}),'VOICE_RESPONSE_FAILED');
});

test('known authentication failure survives sanitization while arbitrary provider details do not',()=>{
 assert.equal(voiceFailureCode(Error('TTS_AUTH_FAILED')),'VOICE_SYNTHESIS_AUTH_FAILED');
 assert.equal(voiceFailureCode(Error('TTS_AUTH_FAILED: secret')),'VOICE_SYNTHESIS_FAILED');
});
