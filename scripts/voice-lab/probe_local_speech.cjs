// No microphones, speakers, app data or external providers. Real local models only.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {setTimeout:delay}=require('node:timers/promises');
const {WaveFile}=require('wavefile');
const {createLocalSpeechProvider}=require('../../electron/local-speech-provider.cjs');
async function run({python,models,output,workerRoot=path.resolve(__dirname,'../..')}){
 fs.mkdirSync(output,{recursive:true});
 const start=performance.now(),host=createLocalSpeechProvider({python:path.resolve(python),workerRoot:path.resolve(workerRoot),modelRoot:path.resolve(models)});
 const report={schema:1,location:'local',opensDevices:false,cloudRequests:false,tests:[]};
 try{
  await host.ready;report.modelLoadMs=Math.round(performance.now()-start);
  async function say(text,label){
   const session=host.connectTts({signal:new AbortController().signal});await session.ready;
   const began=performance.now(),chunks=[];let firstPcmMs;
   assert.ok(session.append(text));assert.ok(session.finish());
   for await(const pcm of session.audio){firstPcmMs??=performance.now()-began;chunks.push(pcm);}
   const pcm=Buffer.concat(chunks),wav=new WaveFile();wav.fromScratch(1,16000,'16',new Int16Array(pcm.buffer,pcm.byteOffset,pcm.length/2));
   fs.writeFileSync(path.join(output,label+'.wav'),wav.toBuffer());
   const metrics={label,text,firstPcmMs:Math.round(firstPcmMs),generationMs:Math.round(performance.now()-began),audioSeconds:pcm.length/32000};report.tests.push(metrics);console.log(JSON.stringify(metrics));return pcm;
  }
  async function recognize(pcm){
   const session=host.connectAsr({signal:new AbortController().signal});await session.ready;
   for(let offset=0;offset<pcm.length;offset+=640){assert.ok(session.append(pcm.subarray(offset,offset+640)));await delay(2);}
   return await session.finish();
  }
  const short=await say('主人，我是希微。你慢慢说，我在认真听呢。','short');
  report.asr=await recognize(short);assert.match(report.asr.text,/主人.*慢慢说.*认真听/);
  await say('主人，文档草稿已经整理好了。项目目前完成了需求梳理，接下来需要核对三个问题。第一，确认本周的交付范围。第二，补齐测试用例。第三，安排下一次评审。所有修改都会保留历史版本，等你确认以后再保存。','long');
  const controller=new AbortController(),cancelled=host.connectTts({signal:controller.signal});await cancelled.ready;cancelled.append('这是一段应该被取消的语音。');cancelled.finish();
  const iterator=cancelled.audio[Symbol.asyncIterator]();await iterator.next();controller.abort();await assert.rejects(iterator.next());
  report.cancellation=true;
  await say('主人，我在。','after-cancel');
  const failed=new AbortController(),asr=host.connectAsr({signal:failed.signal});await asr.ready;asr.append(Buffer.alloc(640));failed.abort();await assert.rejects(asr.result);
  report.asrCancellation=true;
 }finally{await host.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));}
 return report;
}
module.exports={run};
if(require.main===module){if(process.argv.length!==5)throw Error('Usage: node probe_local_speech.cjs <python> <models> <output>');run({python:process.argv[2],models:process.argv[3],output:process.argv[4]}).then(()=>console.log('LOCAL_SPEECH_PROBE_PASSED')).catch(error=>{console.error(error.message);process.exitCode=1;});}
