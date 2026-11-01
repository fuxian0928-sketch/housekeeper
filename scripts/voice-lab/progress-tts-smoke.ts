/** Fixed public progress phrases only; no audio saved or speaker opened. */
import fs from 'node:fs/promises';
import { createQwenRealtimeTts } from '../../server/providers/qwen-realtime-tts.js';
import { progressPhrases, progressStages } from '../../server/domain/voice-progress.js';

async function main() {
  const report=process.argv[2],apiKey=process.env.DASHSCOPE_API_KEY;
  if(!report || !apiKey)throw Error('EXPLICIT_CONFIG_REQUIRED');
  const attempts=[];
  for(const stage of progressStages){
    const controller=new AbortController(),began=performance.now();
    let bytes=0,firstMs:number|null=null,peak=0,failure:string|null=null;
    try {
      const tts=createQwenRealtimeTts({baseUrl:'https://dashscope.aliyuncs.com/api/v1',model:'qwen3-tts-flash-realtime',voice:'Cherry',apiKey,signal:controller.signal,totalMs:10000});
      await tts.ready;
      if(!tts.append(progressPhrases[stage])||!tts.finish())throw Error('TTS_TEXT_REJECTED');
      for await(const pcm of tts.audio){firstMs??=performance.now()-began;bytes+=pcm.length;
        for(let i=0;i<pcm.length;i+=2)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i)));
      }
    }catch(error){const code=error instanceof Error?error.message:'';failure=/^TTS_[A-Z_]+$/.test(code)?code:'PROBE_FAILED';}
    finally{controller.abort();}
    attempts.push({stage,phrase:progressPhrases[stage],firstMs,elapsedMs:performance.now()-began,audioMs:bytes/32,peak,failure,cacheEligible:!failure&&peak>0&&bytes>0&&bytes<=96000});
  }
  const evidence={test:'official-progress-tts',model:'qwen3-tts-flash-realtime',voice:'Cherry',sampleRate:16000,attempts,audioSaved:false,speakerPlayed:false,completedAt:new Date().toISOString()};
  await fs.writeFile(report,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(evidence));
  if(attempts.some(a=>!a.cacheEligible))process.exitCode=1;
}
void main().catch(()=>{console.error('PROGRESS_TTS_PROBE_FAILED');process.exitCode=1;});
