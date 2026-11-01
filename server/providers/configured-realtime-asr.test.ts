import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredRealtimeAsrFactory, validateRealtimeRecognition } from './configured-realtime-asr.js';
import type { createQwenRealtimeAsr, RealtimeAsrOptions } from './qwen-realtime-asr.js';

test('only configured realtime protocol family and official endpoints accepted', () => {
  assert.throws(()=>validateRealtimeRecognition({speechServiceBaseUrl:'https://dashscope.aliyuncs.com'}),/NOT_CONFIGURED/);
  for (const model of ['qwen-audio-3.0-asr-flash','qwen-audio-3.0-asr-flash-streaming','other-realtime']) {
    assert.throws(()=>validateRealtimeRecognition({speechServiceBaseUrl:'https://dashscope.aliyuncs.com',speechRealtimeRecognitionModel:model}),/UNSUPPORTED/);
  }
  assert.throws(()=>validateRealtimeRecognition({speechServiceBaseUrl:'https://third-party.example',speechRealtimeRecognitionModel:'qwen3-asr-flash-realtime'}));
  assert.equal(validateRealtimeRecognition({speechServiceBaseUrl:'https://dashscope.aliyuncs.com',speechRealtimeRecognitionModel:'qwen3-asr-flash-realtime-2026-02-10'}).model,'qwen3-asr-flash-realtime-2026-02-10');
});

test('factory reads fresh secrets per utterance and never connects without valid config/key', () => {
  let key: string | null = 'test-key-one';
  const config={speechServiceBaseUrl:'https://dashscope.aliyuncs.com',speechRealtimeRecognitionModel:'qwen3-asr-flash-realtime'};
  const calls: RealtimeAsrOptions[]=[];
  const connect=((options: RealtimeAsrOptions)=>{calls.push(options);return {} as ReturnType<typeof createQwenRealtimeAsr>;});
  const factory=configuredRealtimeAsrFactory({current:()=>config,effectiveApiKey:()=>key},connect);
  const signal=new AbortController().signal;
  factory(signal,()=>{}); key='test-key-two'; factory(signal,()=>{});
  assert.deepEqual(calls.map(c=>c.apiKey),['test-key-one','test-key-two']);
  key=null; assert.throws(()=>factory(signal,()=>{}),/KEY_NOT_CONFIGURED/);
  key='test-key-two';config.speechServiceBaseUrl='https://third-party.example';
  assert.throws(()=>factory(signal,()=>{})); assert.equal(calls.length,2);
});
