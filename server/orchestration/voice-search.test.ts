import assert from 'node:assert/strict';
import test from 'node:test';
import {voiceSearchQuery, lookupVoiceFacts} from './voice-search.js';
test('facts query, ordinary chat and private context stay separate',()=>{
 for(const m of ['香火在雨中烧，几个寒暑？你知道这首歌吗','卢冠廷是谁','最新新闻','北京天气','帮我查一下这首歌'])assert(voiceSearchQuery(m,[]),m);
 for(const m of ['我今天有点累','这首歌真好听','你是谁','你还记得我是谁吗','查一下我的项目','不要联网，陪我聊聊'])assert.equal(voiceSearchQuery(m,[]),null,m);
});
test('correction follows user evidence, never guessed assistant answer',()=>{
 const q=voiceSearchQuery('你说错了，再确认一下',[{role:'user',content:'香火在雨中烧，这是什么歌？'},{role:'assistant',content:'假歌名和假歌手'}]);
 assert.match(q!,/香火在雨中烧/);assert(!q!.includes('假歌名'));
});
test('bounded source snippets, unavailable search and abort',async()=>{
 const signal=new AbortController().signal;
 const r=await lookupVoiceFacts('歌名',async()=>[{title:'来源',url:'https://example.org/song',content:'事实'.repeat(2000),score:1,publishedAt:null,query:'歌名',purpose:''}],signal);
 assert.equal(r.sources.length,1);assert(JSON.parse(r.context).sources[0].excerpt.length<=1200);
 const empty=await lookupVoiceFacts('歌名',async()=>[],signal);assert.match(empty.context,/不能猜测/);
 const failed=await lookupVoiceFacts('歌名',async()=>{throw Error('timeout')},signal);assert.match(failed.context,/查询失败或超时/);
 const c=new AbortController();c.abort();await assert.rejects(lookupVoiceFacts('歌名',async(_q,s)=>{s.throwIfAborted();return []},c.signal),{name:'AbortError'});
});
