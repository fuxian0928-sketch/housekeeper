import { progressPhrases, progressStages, type ProgressStage } from '../domain/voice-progress.js';
type Profile = { synthesisBaseUrl: string; synthesisModel: string; voice: string; voiceSpeechRate?: number };
type Synthesis = { ready: Promise<void>; append(text: string): boolean; finish(): boolean; cancel(): void; audio: AsyncIterable<Buffer> };
const profileKey = (p: Profile) => JSON.stringify([p.synthesisBaseUrl,p.synthesisModel,p.voice,'zh',16000,p.voiceSpeechRate ?? 1]);

/** One in-memory voice profile, fixed public phrases, no user text or disk files. */
export function createVoiceProgressCache(synthesize: (profile: Profile, signal: AbortSignal) => Synthesis, options: { idleMs?: number; timeoutMs?: number } = {}) {
  const clips = new Map<ProgressStage, Buffer>(), attempts = new Map<ProgressStage, number>();
  let key = '', revision = 0, closed = false, timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined;
  function busy() { revision++; clearTimeout(timer); active?.abort(); active = undefined; }
  function reset() { clips.forEach(pcm=>pcm.fill(0)); clips.clear(); attempts.clear(); }
  async function prepare(profile: Profile, epoch: number) {
    for (const stage of progressStages) {
      if (closed || epoch !== revision) return;
      if (clips.has(stage) || (attempts.get(stage) ?? 0) >= 2) continue;
      attempts.set(stage,(attempts.get(stage) ?? 0)+1);
      const controller = new AbortController(); active = controller;
      let reject!: (error: Error) => void;
      const cancelled = new Promise<never>((_, fail)=>{reject=fail;}); void cancelled.catch(()=>{});
      const abort = () => reject(Error('PROGRESS_PREWARM_CANCELLED'));
      controller.signal.addEventListener('abort',abort,{once:true});
      const deadline=setTimeout(()=>controller.abort(), options.timeoutMs ?? 8000);
      const wait = <T>(promise: PromiseLike<T>) => Promise.race([promise,cancelled]);
      let session: Synthesis | undefined, iterator: AsyncIterator<Buffer> | undefined;
      const chunks: Buffer[]=[]; let bytes=0;
      try {
        session=synthesize(profile,controller.signal); await wait(session.ready);
        controller.signal.throwIfAborted();
        if (!session.append(progressPhrases[stage]) || !session.finish()) throw Error('PROGRESS_PREWARM_REJECTED');
        iterator=session.audio[Symbol.asyncIterator]();
        while (true) {
          const item=await wait(iterator.next()); controller.signal.throwIfAborted();
          if (item.done) break;
          if (!Buffer.isBuffer(item.value) || !item.value.length || item.value.length%2 || (bytes+=item.value.length)>96000) throw Error('PROGRESS_PREWARM_AUDIO_LIMIT');
          chunks.push(Buffer.from(item.value));
        }
        if (!bytes || closed || epoch!==revision) continue;
        const pcm=Buffer.alloc(Math.ceil(bytes/320)*320); let offset=0;
        for (const chunk of chunks) {chunk.copy(pcm,offset);offset+=chunk.length;}
        clips.set(stage,pcm);
      } catch { /* Optional cache miss never fails the foreground conversation. */ }
      finally {
        clearTimeout(deadline); controller.signal.removeEventListener('abort',abort);
        controller.abort(); try {session?.cancel();} catch {}
        try {void Promise.resolve(iterator?.return?.()).catch(()=>{});} catch {}
        chunks.forEach(chunk=>chunk.fill(0)); if(active===controller)active=undefined;
      }
    }
  }
  return {
    busy,
    idle(profile: Profile) {
      if (closed) return;
      busy(); const next=profileKey(profile);
      if(next!==key){reset();key=next;}
      const epoch=revision, snapshot={...profile};
      timer=setTimeout(()=>{void prepare(snapshot,epoch);},options.idleMs ?? 1500); timer.unref?.();
    },
    get(profile: Profile, stage: ProgressStage) {
      const pcm = !closed && profileKey(profile)===key ? clips.get(stage) : undefined;
      return pcm ? Buffer.from(pcm) : null;
    },
    close(){closed=true;busy();reset();}
  };
}
