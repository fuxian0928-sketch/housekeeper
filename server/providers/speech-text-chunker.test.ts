import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechTextChunker} from './speech-text-chunker.js';

test('first sentence is immediate; later complete sentences can coalesce without losing text',()=>{
 const c=new SpeechTextChunker();assert.deepEqual(c.push('主人，我在。接下来先整理资料。'),['主人，我在。']);
 assert.equal(c.hasComplete,true);assert.deepEqual(c.take(true),['接下来先整理资料。']);assert.deepEqual(c.finish(),[]);
});
test('streamed dates, decimals, URLs and closing quotes remain intact',()=>{
 const parts=['评审是2026-10-27 10:30，比例是3.','14。','请查看 https://example.com/v2.0，','结果是“尚未完成。”'];
 const c=new SpeechTextChunker(),out=parts.flatMap(p=>c.push(p));out.push(...c.finish());
 assert.equal(out.join(''),parts.join(''));assert.ok(out.some(s=>s.includes('3.14。')));assert.ok(!out.some(s=>s==='14。'));
 assert.ok(out.some(s=>s.includes('https://example.com/v2.0')));assert.ok(out.some(s=>s.endsWith('。”')));
});
test('a long unpunctuated answer starts within a bounded prefix without dividing a date token',()=>{
 const text='这是一段用于验证中文分段的公开说明'.repeat(5)+'2026-10-27'+'后续内容仍然需要完整保留'.repeat(18);
 const c=new SpeechTextChunker(),out=c.push(text);assert.ok(out.length>0);out.push(...c.finish());
 assert.equal(out.join(''),text);assert.ok(out.every(s=>s.length<=160));assert.ok(out.some(s=>s.includes('2026-10-27')));
});
test('a timer flush never releases an incomplete denial',()=>{
 const c=new SpeechTextChunker();assert.deepEqual(c.push('主人，我在。'),['主人，我在。']);
 assert.deepEqual(c.push('这项任务尚未'),[]);assert.equal(c.hasComplete,false);assert.deepEqual(c.take(true),[]);
 assert.deepEqual(c.push('执行。'),[]);assert.deepEqual(c.take(true),['这项任务尚未执行。']);
});
test('UTF-16 chunk boundaries never create lone surrogates',()=>{
 const text='🙂'.repeat(160);const c=new SpeechTextChunker(),out=[...c.push(text),...c.finish()];
 assert.equal(out.join(''),text);for(const chunk of out)assert.doesNotMatch(chunk,/[\uD800-\uDFFF]/u);
});
