import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('realtime settings remain separate and reject invalid updates before writing credentials', async () => {
  process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'realtime-settings-')),'test.db');
  const {SettingsService}=await import('./settings-service.js');
  const {database,initializeDatabase}=await import('../../db.js');
  initializeDatabase();
  let saved=0;
  const service=new SettingsService({load:()=>null,save:()=>{saved++;},clear:()=>{}});
  try {
    assert.equal(service.current().speechExecution,'local');
    assert.equal(service.nativeVoiceConnection().voice,'xiwei-sweet-soft');
    assert.equal(service.nativeVoiceConnection().speechRealtimeRecognitionModel,'zipformer-local');
    assert.equal(service.current().hasApiKey,false);
    service.update({speechExecution:'cloud'});
    assert.equal(service.current().speechRealtimeRecognitionModel,'');
    const original=service.current().speechRecognitionModel;
    service.update({speechServiceBaseUrl:'https://dashscope.aliyuncs.com/api/v1',speechRealtimeRecognitionModel:'qwen3-asr-flash-realtime'});
    assert.equal(new SettingsService().current().speechRealtimeRecognitionModel,'qwen3-asr-flash-realtime');
    assert.equal(service.current().speechRecognitionModel,original);
    const oldTts = service.current().speechSynthesisModel;
    const synthesis = { speechRealtimeSynthesisBaseUrl:'https://dashscope.aliyuncs.com/api/v1', speechRealtimeSynthesisModel:'qwen3-tts-flash-realtime', speechRealtimeVoice:'Cherry' };
    service.update(synthesis);
    assert.deepEqual(new SettingsService().nativeVoiceConnection(), {
      speechServiceBaseUrl:'https://dashscope.aliyuncs.com/api/v1', speechRealtimeRecognitionModel:'qwen3-asr-flash-realtime',
      synthesisBaseUrl:synthesis.speechRealtimeSynthesisBaseUrl, synthesisModel:synthesis.speechRealtimeSynthesisModel, voice:'Cherry'
    });
    assert.equal(service.current().speechSynthesisModel,oldTts);
    assert.equal(service.current().speechLegacyRecognitionBaseUrl, '');
    assert.equal(service.current().speechLegacySynthesisBaseUrl, '');
    service.update({ speechLegacyRecognitionBaseUrl: 'https://legacy-asr.example/v1', speechLegacySynthesisBaseUrl: 'https://legacy-tts.example/v1' });
    assert.equal(service.current().speechLegacyRecognitionBaseUrl, 'https://legacy-asr.example/v1');
    assert.equal(service.current().speechLegacySynthesisBaseUrl, 'https://legacy-tts.example/v1');
    assert.equal(service.current().speechServiceBaseUrl, 'https://dashscope.aliyuncs.com/api/v1');
    for (const invalid of [{speechRealtimeVoice:'bad voice'}, {speechRealtimeSynthesisModel:'legacy-tts'}, {speechRealtimeSynthesisBaseUrl:'https://third-party.example'}, {speechRealtimeVoice:12}]) {
      assert.throws(()=>service.update({...invalid,apiKey:'test-key-that-is-long-enough'} as any));
      assert.equal(saved,0);
      assert.equal(service.nativeVoiceConnection().voice,'Cherry');
    }
    service.update({speechRealtimeVoice:'Serena'});
    assert.equal(service.nativeVoiceConnection().voice,'Serena');
    service.update({speechRealtimeSynthesisBaseUrl:'',speechRealtimeSynthesisModel:'',speechRealtimeVoice:''});
    assert.equal(service.nativeVoiceConnection().synthesisModel,'');
    assert.throws(()=>service.update({speechRealtimeRecognitionModel:'qwen-audio-3.0-asr-flash',apiKey:'test-key-that-is-long-enough'}));
    assert.equal(saved,0);
    assert.throws(()=>service.update({speechServiceBaseUrl:'https://third-party.example'}));
    assert.equal(service.current().speechServiceBaseUrl,'https://dashscope.aliyuncs.com/api/v1');
    service.update({speechRealtimeRecognitionModel:''});
    assert.equal(service.current().speechRealtimeRecognitionModel,'');
  } finally {database.close();}
});
