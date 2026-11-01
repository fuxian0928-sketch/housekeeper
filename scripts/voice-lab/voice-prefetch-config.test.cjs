const test=require('node:test');
const assert=require('node:assert/strict');
const {readVoicePrefetch,sanitizeVoicePrefetch}=require('../../electron/voice-prefetch-config.cjs');
test('prefetch defaults and settings reject malformed or unbounded values',()=>{
 assert.deepEqual(readVoicePrefetch({}),{voicePrefetchEnabled:false,voicePrefetchAttempts:2});
 assert.deepEqual(readVoicePrefetch({voicePrefetchEnabled:false,voicePrefetchAttempts:1}),{voicePrefetchEnabled:false,voicePrefetchAttempts:1});
 assert.deepEqual(readVoicePrefetch({voicePrefetchEnabled:true}),{voicePrefetchEnabled:true,voicePrefetchAttempts:2});
 for(const value of [-1,0,3,100,Infinity,'1',null])assert.deepEqual(sanitizeVoicePrefetch({voicePrefetchEnabled:'false',voicePrefetchAttempts:value}),{});
});
