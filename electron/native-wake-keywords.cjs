const fs=require('node:fs'),path=require('node:path');
const {pinyin}=require('pinyin-pro');
const {readWakeWord,isBuiltInWakeWord,defaultWakePhrases,legacyWakePhrases}=require('./assistant-identity.cjs');
function wakeDefinition(config){
 if(config.wakeWord!==undefined&&typeof config.wakeWord!=='string')throw Error('VOICE_NATIVE_WAKE_WORD_INVALID');
 const word=readWakeWord(config).trim();
 if(!/^[\p{Script=Han}Ee]{2,12}$/u.test(word))throw Error('VOICE_NATIVE_WAKE_WORD_INVALID');
 const phrases=isBuiltInWakeWord(word)?[...defaultWakePhrases,...legacyWakePhrases]:[word];
 const setting=Number.isFinite(config.wakeWordThreshold)?Math.min(.95,Math.max(.45,config.wakeWordThreshold)):.66;
 // Translate legacy slider position into an acoustic threshold, not a probability.
 const threshold=Number((.15+(setting-.45)*(.2/.21)).toFixed(3));
 return {word,threshold,phrases};
}
function compileWakeKeywords(config,tokens){
 const definition=wakeDefinition(config);
 const lines=definition.phrases.map(phrase=>{
  const phones=pinyin(phrase,{type:'array',toneType:'symbol'}).flatMap(syllable=>{
   if(/^[eE]+$/.test(syllable))return Array.from(syllable,()=> 'IY1');
   const match=syllable.match(/^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])(.+)$/u);
   return match?[match[1],match[2]]:[syllable];
  });
  if(phones.some(phone=>!tokens.has(phone)))throw Error('VOICE_NATIVE_WAKE_PRONUNCIATION_UNSUPPORTED');
  return phones.join(' ')+` :1.5 #${definition.threshold} @${phrase}`;
 });
 return {...definition,text:lines.join('\n')+'\n'};
}
function prepareNativeWakeKeywords({config,model,dataDirectory}){
 const tokens=new Set(fs.readFileSync(path.join(model,'tokens.txt'),'utf8').split(/\r?\n/).filter(Boolean).map(line=>line.split(/\s+/)[0]));
 const result=compileWakeKeywords(config,tokens);
 const file=path.join(dataDirectory,'native-wake-keywords.txt');fs.mkdirSync(dataDirectory,{recursive:true});fs.writeFileSync(file+'.tmp',result.text,'utf8');fs.renameSync(file+'.tmp',file);
 return file;
}
module.exports={wakeDefinition,compileWakeKeywords,prepareNativeWakeKeywords};
