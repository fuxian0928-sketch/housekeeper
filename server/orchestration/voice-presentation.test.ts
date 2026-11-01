import test from 'node:test';
import assert from 'node:assert/strict';
import {readVoicePresentation} from './voice-presentation.js';
test('one model result keeps the original and narration separate',()=>{
 const answer='## 预算\n**30万元**（待核实）',narration='预算是30万元，这个数还需要核实。';
 assert.deepEqual(readVoicePresentation(JSON.stringify({answer,narration})),{answer,narration});
 assert.deepEqual(readVoicePresentation('普通回答。'),{answer:'普通回答。'});
 assert.deepEqual(readVoicePresentation('```json\n'+JSON.stringify({answer,narration})+'\n```'),{answer,narration});
});
test('new numeric claims or oversized narration fall back to the unchanged original',()=>{
 for(const narration of ['预算是300万元。','字'.repeat(1801)])assert.deepEqual(readVoicePresentation(JSON.stringify({answer:'预算30万元，待核实。',narration})),{answer:'预算30万元，待核实。'});
 assert.throws(()=>readVoicePresentation('{"answer":"未完成'),/格式未完成/);
});

test('prose followed by an envelope is normalized once before display and storage',()=>{
 const answer='主人，刚才那句话是我多嘴了。我现在安静。';
 const envelope=JSON.stringify({answer,narration:answer});
 assert.deepEqual(readVoicePresentation(`${answer}\n\n${envelope}`),{answer,narration:answer});
 assert.deepEqual(readVoicePresentation(`${answer}\n\n\`\`\`json\n${envelope}\n\`\`\``),{answer,narration:answer});
 const full='## 核对结果\n预算30万元，尚未确认。';
 assert.deepEqual(readVoicePresentation(`先说明：资料存在缺口。\n${JSON.stringify({answer:full,narration:'预算30万元，尚未确认。'})}`),{
  answer:`先说明：资料存在缺口。\n\n${full}`,narration:'预算30万元，尚未确认。'
 });
 assert.throws(()=>readVoicePresentation(`${answer}\n{"answer":"不完整`),/格式未完成/);
 assert.throws(()=>readVoicePresentation(`${envelope}\n又附加了一段话`),/格式未完成/);
});

test('literal braces and ordinary JSON remain part of the written answer',()=>{
 const answer='配置示例：`{"theme":"white"}`，不要更改。';
 assert.deepEqual(readVoicePresentation(JSON.stringify({answer,narration:'配置不要更改。'})),{answer,narration:'配置不要更改。'});
 assert.deepEqual(readVoicePresentation('{"theme":"white"}'),{answer:'{"theme":"white"}'});
});
