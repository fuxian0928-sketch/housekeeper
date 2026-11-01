const test=require('node:test'),assert=require('node:assert/strict');
const {wakeDefinition,compileWakeKeywords}=require('../../electron/native-wake-keywords.cjs');
const tokens=new Set(['x','iǎo','IY1','y','ī','ì','n','ǐ','h','ǎo','m','sh','ū','w','ēi']);
test('default wake keeps short, repeated and homophone variants at current acoustic threshold',()=>{
 const result=compileWakeKeywords({},tokens);assert.equal(result.word,'希微希微');assert.equal(result.phrases.length,8);assert.equal(result.threshold,.35);
 assert.ok(result.text.includes('x ī w ēi :1.5 #0.35 @希微\n'));
 assert.ok(result.text.includes('x ī w ēi x ī w ēi :1.5 #0.35 @希微希微\n'));
 assert.ok(result.text.includes('x iǎo IY1 :1.5 #0.35 @小E\n'));
 assert.ok(result.text.includes('x iǎo y ì :1.5 #0.35 @小艺\n'));
 assert.equal(require('node:fs').readFileSync(require('node:path').join(__dirname,'xiao-e-keywords.txt'),'utf8').replace(/\r\n/g,'\n'),result.text);
 for(const wakeWord of ['小E小E','小e小e','小E','希微'])assert.deepEqual(compileWakeKeywords({wakeWord},tokens).phrases,result.phrases);
});
test('custom Chinese wake phrase is translated into validated model tokens',()=>{
 const result=compileWakeKeywords({wakeWord:'你好小秘书'},tokens);assert.equal(result.text,'n ǐ h ǎo x iǎo m ì sh ū :1.5 #0.35 @你好小秘书\n');
 assert.equal(compileWakeKeywords({wakeWord:'小EE'},tokens).text,'x iǎo IY1 IY1 :1.5 #0.35 @小EE\n');
 assert.deepEqual(wakeDefinition({wakeWord:'你好小秘书'}).phrases,['你好小秘书']);
});
test('unsupported words and token injection are rejected',()=>{
 for(const word of ['E','小E #0.01','hello','小E\n@其他',null,'你好'.repeat(7)])assert.throws(()=>wakeDefinition({wakeWord:word}),/VOICE_NATIVE_WAKE_WORD_INVALID/);
 assert.throws(()=>compileWakeKeywords({wakeWord:'你好小秘书'},new Set(['n'])),/PRONUNCIATION_UNSUPPORTED/);
});
test('stricter setting actually increases native acoustic threshold',()=>{
 assert.ok(wakeDefinition({wakeWordThreshold:.95}).threshold>wakeDefinition({wakeWordThreshold:.45}).threshold);
});
