import test from 'node:test';
import assert from 'node:assert/strict';
import {answerDigest,withVoicePlaybackContext} from './voice-playback-context.js';
const history=[{role:'user',content:'新建任务'},{id:'m1',role:'assistant',content:'任务已创建。'}];
const receipt={conversationId:'c',assistantMessageId:'m1',answerHash:answerDigest('任务已创建。'),state:'partial',answerSubmittedSamples:160,attribution:'known'};
test('partial output adds conservative note without altering stored text or operation result',()=>{
 const h=withVoicePlaybackContext(history,'c',receipt);
 assert.match(h[1].content,/只有部分音频/);assert.match(h[1].content,/不要因为未播报而重复执行/);
 assert.equal(history[1].content,'任务已创建。');
});
test('only progress heard means no confirmed answer audio, complete submission is not hearing',()=>{
 assert.match(withVoicePlaybackContext(history,'c',{...receipt,answerSubmittedSamples:0})[1].content,/没有确认提交/);
 assert.match(withVoicePlaybackContext(history,'c',{...receipt,state:'submitted'})[1].content,/未验证音箱出声/);
});
test('wrong conversation, wrong text, unknown attribution and duplicates stay unknown',()=>{
 for(const r of [null,{...receipt,conversationId:'other'},{...receipt,answerHash:'wrong'},{...receipt,attribution:'unknown'}])assert.match(withVoicePlaybackContext(history,'c',r)[1].content,/播放状态未确认/);
 const duplicated=[...history,...history];assert.match(withVoicePlaybackContext(duplicated,'c',receipt).at(-1)!.content,/播放状态未确认/);
});

test('identical text on different messages binds only the current message',()=>{
 const h=[...history,{id:'m2',role:'assistant',content:'任务已创建。'}];
 assert.match(withVoicePlaybackContext(h,'c',receipt).at(-1)!.content,/播放状态未确认/);
 assert.match(withVoicePlaybackContext(h,'c',{...receipt,assistantMessageId:'m2'}).at(-1)!.content,/只有部分音频/);
 assert.match(withVoicePlaybackContext(history,'c',{...receipt,assistantMessageId:undefined})[1].content,/播放状态未确认/);
});
