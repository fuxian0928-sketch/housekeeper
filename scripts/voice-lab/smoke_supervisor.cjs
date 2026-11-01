const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { VoiceWorkerSupervisor } = require('../../electron/voice-worker-supervisor.cjs');

(async () => {
  const root=process.cwd();
  const lab=process.env.VOICE_LAB_ROOT || path.join(root,'outputs/voice-lab');
  const report=path.join(root,`outputs/voice-lab/supervised-duplex-${Date.now()}.json`);
  const supervisor=new VoiceWorkerSupervisor({
    executable:path.join(lab,'venv/Scripts/python.exe'),
    args:['scripts/voice-lab/run_duplex.py','--model',path.join(lab,'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20'),'--input-name','2K USB Camera','--output-name','Realtek','--seconds','30','--control-stdin','--stream-pcm','--report',report],
    cwd:root, stopMs:3000, audioConsumer:()=>true
  });
  const faults=[];
  supervisor.on('fault',f=>faults.push(f));
  try {
    await supervisor.start();
    await new Promise(resolve=>setTimeout(resolve,3000));
  } finally { await supervisor.stop(); }
  assert.deepEqual(faults,[]);
  const result=JSON.parse(await fs.readFile(report,'utf8'));
  assert.equal(result.failure,null);
  assert.equal(result.streamsClosed,true);
  assert.equal(result.ringCleared,true);
  assert.ok(result.processedFrames>100);
  assert.ok(result.events.some(e=>e.type==='alive'));
  console.log(JSON.stringify({passed:true,frames:result.processedFrames,seconds:result.seconds}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
