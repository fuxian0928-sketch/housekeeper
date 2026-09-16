import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CONVERSATION_IDLE_MS, IDLE_FAREWELL, listenUntilIdle, NoSpeechError } from './voice-listening';
test('five minute default and exact farewell',()=>{
 assert.equal(CONVERSATION_IDLE_MS,300000);
 assert.equal(IDLE_FAREWELL,'那主人继续忙吧，小e先退下啦，有事主人随时叫我哦');
});
test('silence retries until deadline, then returns standby',async()=>{
 let attempts=0;
 const result=await listenUntilIdle(async signal=>{attempts++;await delay(5,undefined,{signal});throw new NoSpeechError()},new AbortController().signal,40);
 assert.equal(result,null);assert(attempts>1);
});
test('speech after silent attempts returns without waiting for standby',async()=>{
 let attempts=0;
 assert.equal(await listenUntilIdle(async()=>{if(++attempts<4)throw new NoSpeechError();return '继续聊'},new AbortController().signal,100),'继续聊');
});
test('interrupt is not idle farewell and service errors are not hidden',async()=>{
 const controller=new AbortController();
 const pending=listenUntilIdle(async signal=>{await delay(100,undefined,{signal});return '旧话'},controller.signal,1000);
 controller.abort();await assert.rejects(pending,{name:'AbortError'});
 await assert.rejects(listenUntilIdle(async()=>{throw Error('ASR故障')},new AbortController().signal),/ASR故障/);
});
