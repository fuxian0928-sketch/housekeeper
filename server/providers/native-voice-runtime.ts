import { createNativeMemoryPrefetch } from './native-memory-prefetch.js';
import { isDismissCommand, IDLE_FAREWELL, progressModeCommand,computerControlCommand } from '../domain/voice-session-commands.js';
import { createNativeConversationOwner, type ConversationDependencies } from './native-conversation-owner.js';
import { createNativeResponsePipeline, type ResponsePipelineDependencies } from './native-response-pipeline.js';
import { createNativeSharedChat } from './native-shared-chat.js';
import { createQwenRealtimeAsr, qwenRealtimeUrl } from './qwen-realtime-asr.js';
import { createQwenRealtimeTts } from './qwen-realtime-tts.js';
import { validateRealtimeRecognition } from './configured-realtime-asr.js';
import { createInterruptionController, type InterruptionKey } from './voice-interruption-controller.js';
import type { NativeAudioPacket } from './native-recognition-owner.js';
import { createVoiceProgressScheduler } from '../domain/voice-progress-scheduler.js';
import type { ProgressStage } from '../domain/voice-progress.js';
import { createVoiceProgressCache } from './voice-progress-cache.js';
import { acceptsWakeTranscript } from '../domain/voice-wake-transcript.js';
import type { PlaybackContext } from '../domain/voice-playback-context.js';

type InterruptionWorker = ReturnType<Parameters<typeof createNativeConversationOwner>[0]> & {
  resolveInterruption?(key: InterruptionKey, decision: 'resume' | 'interrupt' | 'stop'): boolean;
};
type InterruptiblePlayer = ResponsePipelineDependencies['player'] & {
  pause?(key: { generation: number; audioGeneration: number; turn: number }, pauseId: number): boolean;
  resume?(key: { generation: number; audioGeneration: number; turn: number }, pauseId: number): boolean;
};

export type NativeVoiceSettings = {
  speechExecution?: 'local' | 'cloud';
  speechServiceBaseUrl: string; speechRealtimeRecognitionModel: string;
  synthesisBaseUrl: string; synthesisModel: string; voice: string; voiceSpeechRate?: number;
  routingMode: 'life' | 'work' | 'auto'; projectId?: string | null;
  voiceChatModel?: string; voiceReasoningEffort?: 'follow' | 'auto' | 'low' | 'medium' | 'high';
  voiceFarewellText?: string;
  wakeWord?: string;
  voicePrefetchEnabled?: boolean;
  voicePrefetchAttempts?: 1 | 2;
  voiceProgressMode?: 'off' | 'concise' | 'detailed';
  voiceProgressFirstMs?: number; voiceProgressIntervalMs?: number;
};
type Options = {
  // All providers and factories are owned by trusted service/main, never renderer IPC.
  settings(): NativeVoiceSettings;
  key(purpose: 'recognition' | 'synthesis'): string | null;
  chatBaseUrl: string;
  deviceId?: string;
  initialSessionCloses?: Array<{ conversationId: string; routingMode: NativeVoiceSettings['routingMode']; projectId: string | null }>;
  onSessionCloseAcknowledged?(conversationId: string): void;
  conversation: { read(): string | null; save(id: string): void; clear(): string | null };
  createWorker(consume: (packet: NativeAudioPacket) => boolean, interruptionConsume?: (packet: NativeAudioPacket & { pauseId: number }) => boolean): InterruptionWorker;
  createPlayer(worker: InterruptionWorker): InterruptiblePlayer;
  onStatus?: ConversationDependencies['onStatus'];
  onNavigation?(request:import('../domain/interaction/navigation-delivery.js').NavigationRequest):void;
  onActivity?(event:{conversationId:string;runId?:string}):void;
  onComputerControl?(action:'connect'|'disconnect'):Promise<unknown>;
  captureCameraFrame?:(signal:AbortSignal)=>Promise<string|null>;
  onResponseStage?(key:{generation:number;audioGeneration:number;turn:number},stage:import('./native-response-pipeline.js').ResponseStage):void;
  onSynthesisMetric?(key:{generation:number;audioGeneration:number;turn:number},metric:import('./qwen-realtime-tts.js').SpeechSynthesisMetric):void;
  onResponseFault?(key:{generation:number;audioGeneration:number;turn:number},code:string):void;
  onRecognition?: ConversationDependencies['onRecognition'];
  connectAsr?: typeof createQwenRealtimeAsr;
  connectTts?: typeof createQwenRealtimeTts;
  // Trusted, configuration-keyed PCM cache only. No on-demand network work here.
  cachedProgress?(settings: NativeVoiceSettings, stage: ProgressStage): Buffer | null;
  prewarmProgress?: boolean;
  playbackContext?(conversationId: string): PlaybackContext | null;
  onAnswer?(key: { generation:number;audioGeneration:number;turn:number },conversationId:string,answerHash:string,assistantMessageId:string): void;
  onPlaybackReceipt?(key: { generation: number; audioGeneration: number; turn: number }, frames: number): void;
  onAudioPacket?(key: { generation: number; audioGeneration: number; turn: number }, kind: 'answer' | 'progress', bytes: number): void;
};

function validate(settings: NativeVoiceSettings) {
  if (settings.voiceProgressMode !== undefined && !['off','concise','detailed'].includes(settings.voiceProgressMode)) throw Error('VOICE_INVALID_PROGRESS_CONFIG');
  for (const [value,min,max] of [[settings.voiceProgressFirstMs,1000,5000],[settings.voiceProgressIntervalMs,5000,20000]]) {
    if (value !== undefined && (!Number.isFinite(value) || value < min! || value > max!)) throw Error('VOICE_INVALID_PROGRESS_CONFIG');
  }
  if (settings.voiceSpeechRate !== undefined && (!Number.isFinite(settings.voiceSpeechRate) || settings.voiceSpeechRate < 0.5 || settings.voiceSpeechRate > 2)) throw Error('VOICE_INVALID_SPEECH_RATE');
  if (settings.voiceFarewellText !== undefined && (typeof settings.voiceFarewellText !== 'string' || !settings.voiceFarewellText.trim() || settings.voiceFarewellText.length > 120 || /[\x00-\x1f]/.test(settings.voiceFarewellText))) throw Error('VOICE_INVALID_FAREWELL');
  if (settings.speechExecution === 'local') {
    if (settings.speechRealtimeRecognitionModel !== 'zipformer-local' || settings.synthesisModel !== 'moss-local' || settings.voice !== 'xiwei-sweet-soft') throw Error('VOICE_LOCAL_PROFILE_INVALID');
  } else {
    validateRealtimeRecognition(settings);
    qwenRealtimeUrl(settings.synthesisBaseUrl, settings.synthesisModel);
    if (!/^qwen3-tts-(?:instruct-)?flash-realtime(?:-[\w.-]+)?$/.test(settings.synthesisModel) || !/^[\w.-]{1,160}$/.test(settings.voice)) throw Error('VOICE_INVALID_SYNTHESIS_CONFIG');
  }
  if (!['life', 'work', 'auto'].includes(settings.routingMode)) throw Error('VOICE_INVALID_MODE');
}

/** Explicit opt-in assembly. Constructing it does not open a device or network. */
export function createNativeVoiceRuntime(options: Options) {
  const prefetch = createNativeMemoryPrefetch(options.chatBaseUrl);
  const sessionCloseEndpoint = new URL('/api/voice/session-close', options.chatBaseUrl);
  type SessionClose = { conversationId: string; routingMode: NativeVoiceSettings['routingMode']; projectId: string | null; deviceId?: string };
  const pendingSessionCloses = new Map<string, SessionClose>();
  let closePersistenceFailed = false;
  let sessionCloseBarrier: Promise<void> = Promise.resolve();
  const postSessionClose = async (payload: SessionClose) => {
    const response = await fetch(sessionCloseEndpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!response.ok) throw Error('VOICE_SESSION_CLOSE_FAILED');
    await response.arrayBuffer();
  };
  const queueSessionClose = (payload: SessionClose) => {
    const request = { ...payload, ...(options.deviceId ? { deviceId: options.deviceId } : {}) };
    pendingSessionCloses.set(request.conversationId, request);
    sessionCloseBarrier = sessionCloseBarrier.then(async () => {
      try { await postSessionClose(request); options.onSessionCloseAcknowledged?.(request.conversationId); pendingSessionCloses.delete(request.conversationId); }
      catch { /* Retry before the next chat turn. */ }
    });
  };
  const closeConversation = () => {
    let conversationId: string | null;
    try { conversationId = options.conversation.clear(); closePersistenceFailed = false; }
    catch { closePersistenceFailed = true; return; }
    if (!conversationId) return;
    const current = responseSettings ?? snapshot ?? options.settings();
    queueSessionClose({ conversationId, routingMode: current.routingMode,
      projectId: current.routingMode === 'life' ? null : current.projectId ?? null });
  };
  let startupSessionCloses = options.initialSessionCloses;
  const finishSessionCloses = async (signal: AbortSignal) => {
    if (closePersistenceFailed) closeConversation();
    if (closePersistenceFailed) throw Error('VOICE_SESSION_CLOSE_PERSIST_FAILED');
    await sessionCloseBarrier;
    for (const payload of [...pendingSessionCloses.values()]) {
      signal.throwIfAborted();
      try { await postSessionClose(payload); options.onSessionCloseAcknowledged?.(payload.conversationId); pendingSessionCloses.delete(payload.conversationId); }
      catch { /* The next turn must not consume a stale handoff. */ }
    }
    signal.throwIfAborted();
    if (pendingSessionCloses.size) throw Error('VOICE_SESSION_CLOSE_FAILED');
  };
  const turnId = (key: {workerGeneration:number;audioGeneration:number;turn:number}) => `${key.workerGeneration}:${key.audioGeneration}:${key.turn}`;
  let sessionProgressMode: NativeVoiceSettings['voiceProgressMode'];
  let snapshot: NativeVoiceSettings | undefined;
  let snapshotKeys: { recognition: string; synthesis: string } | undefined;
  let responseSettings: NativeVoiceSettings | undefined;
  let player!: InterruptiblePlayer;
  let audioWorker!: InterruptionWorker;
  let candidate: InterruptionKey | undefined;
  let processingCandidate = false;
  let audioGate: Promise<void> | undefined, releaseAudio: (() => void) | undefined;
  const releaseCandidateAudio = () => { releaseAudio?.(); releaseAudio = undefined; audioGate = undefined; processingCandidate = false; };
  // Validate local endpoint before creating the audio worker.
  createNativeSharedChat({ baseUrl: options.chatBaseUrl, settings: () => ({ routingMode: 'life' }), onConversation() {} });
  const getKey = (purpose: 'recognition' | 'synthesis') => {
    if ((responseSettings ?? snapshot ?? options.settings()).speechExecution === 'local') {
      if (!options.connectAsr || !options.connectTts) throw Error('VOICE_LOCAL_PROVIDER_MISSING');
      return '';
    }
    const key = options.key(purpose);
    if (!key?.trim() || /[\r\n]/.test(key)) throw Error('VOICE_KEY_NOT_CONFIGURED');
    return key;
  };
  const cache = options.prewarmProgress ? createVoiceProgressCache((profile, signal) => (options.connectTts ?? createQwenRealtimeTts)({
    baseUrl: profile.synthesisBaseUrl, model: profile.synthesisModel, voice: profile.voice, speechRate: profile.voiceSpeechRate ?? 1, apiKey: getKey('synthesis'), signal
  })) : undefined;
  const cachedProgress = options.cachedProgress ?? (cache ? (profile: NativeVoiceSettings, stage: ProgressStage) => cache.get(profile,stage) : undefined);
  const interruption = createInterruptionController({
    createSession(signal, onPartial) {
      const current = { ...(responseSettings ?? snapshot ?? options.settings()) }; validate(current);
      return (options.connectAsr ?? createQwenRealtimeAsr)({ baseUrl: current.speechServiceBaseUrl,
        model: current.speechRealtimeRecognitionModel, apiKey: snapshotKeys?.recognition ?? getKey('recognition'), signal,
        onPartial: preview => onPartial(preview.text) });
    },
    pause: key => processingCandidate || (player.pause?.({ ...key, generation: key.workerGeneration }, key.pauseId) ?? false),
    resume(key) {
      audioWorker.resolveInterruption?.(key, 'resume');
      return player.resume?.({ ...key, generation: key.workerGeneration }, key.pauseId) ?? false;
    },
    confirm: (key, decision) => audioWorker.resolveInterruption?.(key, decision) ?? false,
    onStatus(event) { if (event.type === 'resumed') releaseCandidateAudio(); }
  });
  const retireCandidate = () => { if (candidate) interruption.retire(candidate); candidate = undefined; releaseCandidateAudio(); };
  let eventGeneration = 0, eventAudioGeneration = 0, eventTurn = 0, eventRetired = true;
  const interruptionEvent = (event: { type: string; generation: number; audioGeneration?: number; turn?: number; pauseId?: number; frameCount?: number; phase?: 'processing'|'speaking' }) => {
    // Side effects must obey the same generation/turn boundary as recognition.
    if (event.type === 'ready') {
      if (!Number.isSafeInteger(event.generation) || event.generation <= eventGeneration) return;
      eventGeneration = event.generation; eventAudioGeneration = 0; eventTurn = 0; eventRetired = false;
    } else {
      if (eventRetired || event.generation !== eventGeneration) return;
      if (event.audioGeneration !== undefined || event.turn !== undefined) {
        if (!Number.isSafeInteger(event.audioGeneration) || event.audioGeneration! < 1 || !Number.isSafeInteger(event.turn) || event.turn! < 0) return;
        if (event.audioGeneration! < eventAudioGeneration || (event.audioGeneration === eventAudioGeneration && event.turn! < eventTurn)) return;
        eventAudioGeneration = event.audioGeneration!; eventTurn = event.turn!;
      }
    }
    if (['turn-start','turn-cancelled','standby','idle-farewell','voice-preview'].includes(event.type)) prefetch.cancel();
    if (event.type === 'standby') closeConversation();
    if (event.type === 'turn-start') responseSettings = undefined;
    if (event.type === 'standby' || event.type === 'ready') sessionProgressMode = undefined;
    if (['turn-start','idle-farewell','voice-preview','interruption-start','listening'].includes(event.type)) cache?.busy();
    if (['ready','standby'].includes(event.type)) {
      const config=options.settings();
      if (config.voiceProgressMode !== 'off' && config.routingMode !== 'life') cache?.idle(config);
    }
    const key = { workerGeneration: event.generation, audioGeneration: event.audioGeneration!, turn: event.turn!, pauseId: event.pauseId! };
    if (event.type === 'interruption-start') {
      if (![key.workerGeneration,key.audioGeneration,key.turn,key.pauseId].every(n=>Number.isSafeInteger(n)&&n>0)) return;
      if (candidate) {
        const order=key.workerGeneration-candidate.workerGeneration || key.audioGeneration-candidate.audioGeneration || key.turn-candidate.turn || key.pauseId-candidate.pauseId;
        if (order<=0) return;
      }
      retireCandidate(); candidate = key; processingCandidate = event.phase === 'processing';
      if (processingCandidate) audioGate = new Promise(resolve => { releaseAudio = resolve; });
      if (!interruption.begin(key)) releaseCandidateAudio();
    }
    else if (event.type === 'interruption-end') interruption.finish(key, event.frameCount!);
    else if (event.type === 'interruption-cancelled') { interruption.retire(key); if(candidate && candidate.pauseId===key.pauseId && candidate.turn===key.turn && candidate.workerGeneration===key.workerGeneration && candidate.audioGeneration===key.audioGeneration) releaseCandidateAudio(); }
    else if (candidate && event.generation === candidate.workerGeneration &&
      ['turn-cancelled','standby','turn-start'].includes(event.type)) retireCandidate();
  };
  const workerRetired = (event: { generation: number }) => { if (event.generation !== eventGeneration || eventRetired) return; eventRetired = true; prefetch.cancel(); cache?.busy(); retireCandidate(); snapshot = undefined; snapshotKeys = undefined; responseSettings = undefined; sessionProgressMode = undefined; };
  const owner = createNativeConversationOwner(consume => {
    const worker = options.createWorker(consume, packet => {
      interruption.append(packet, packet.sequence, packet.pcm, packet.capturedAt);
      return true; // Packets in flight after candidate retirement are expected and discarded.
    });
    audioWorker = worker; player = options.createPlayer(worker);
    worker.on('event', interruptionEvent); worker.on('fault', workerRetired); worker.on('closed', workerRetired);
    return worker;
  }, {
    acceptWakeTranscript: text => acceptsWakeTranscript(text, snapshot?.wakeWord ?? options.settings().wakeWord ?? '希微希微'),
    createSession(signal, onPartial) {
      snapshot = { ...options.settings(), ...(sessionProgressMode ? {voiceProgressMode:sessionProgressMode} : {}) }; validate(snapshot);
      // Recognition and synthesis for one utterance must use the same saved
      // credential generation even when a profile is edited mid-turn.
      snapshotKeys = { recognition: getKey('recognition'), synthesis: getKey('synthesis') };
      return (options.connectAsr ?? createQwenRealtimeAsr)({
        baseUrl: snapshot.speechServiceBaseUrl, model: snapshot.speechRealtimeRecognitionModel,
        apiKey: snapshotKeys.recognition, signal, onPartial
      });
    },
    async respond(context) {
      if (!snapshot && context.control !== 'idle-farewell' && context.control !== 'voice-preview') throw Error('VOICE_MISSING_TURN_SETTINGS');
      // Freeze configuration before awaits. Subsequent turns may replace snapshot.
      const current = { ...((context.control === 'idle-farewell' || context.control === 'voice-preview') ? options.settings() : snapshot!) };
      const currentKeys = context.control === 'idle-farewell' || context.control === 'voice-preview'
        ? { recognition: getKey('recognition'), synthesis: getKey('synthesis') }
        : { ...(snapshotKeys ?? { recognition: getKey('recognition'), synthesis: getKey('synthesis') }) };
      validate(current);
      responseSettings = current;
      const progressCommand = context.control ? null : progressModeCommand(context.text);
      const computerCommand=context.control?null:computerControlCommand(context.text);
      if (progressCommand) { sessionProgressMode = progressCommand; cache?.busy(); }
      const dismiss = context.control === 'voice-preview' || context.control === 'idle-farewell' || isDismissCommand(context.text);
      // A local dismissal must stop new capture before any remote handoff can
      // delay it. No chat or memory lookup is needed for the farewell.
      if (dismiss && !context.requestStandby()) throw Error('VOICE_TURN_RETIRED');
      if (!dismiss && !progressCommand && !context.control) await finishSessionCloses(context.signal);
      const conversationId = options.conversation.read();
      const voicePrefetchToken = dismiss ? (prefetch.cancel(), undefined) : prefetch.finish(turnId(context.key), context.text, { ...current, conversationId });
      const progress = createVoiceProgressScheduler({ mode: dismiss || progressCommand ? 'off' : current.voiceProgressMode ?? 'concise', firstDelayMs: current.voiceProgressFirstMs, intervalMs: current.voiceProgressIntervalMs });
      const answer = computerCommand ? async function* () { if(!options.onComputerControl){yield '当前客户端尚未接入本机控制。';return;} try{await options.onComputerControl(computerCommand);yield computerCommand==='connect'?'本机控制已连接，主人可以交代要处理的事。':'本机控制已断开。';}catch{yield '本机控制未连接成功，请查看页面中的具体原因。';} } : progressCommand ? async function* () { yield progressCommand === 'off' ? '本次聊天已关闭过程播报，结果和需要确认的事情仍会告诉你。' : progressCommand === 'concise' ? '本次聊天会简洁播报处理进度。' : '本次聊天会详细播报重要处理阶段。'; } : context.control === 'voice-preview' ? async function* () { yield '这是希微的语音试听，正在使用已保存的音色、语速和音量。试听结束后，我会回到待机。'; } : context.control === 'utterance-limit' ? async function* () { yield '这段话有点长，本轮没有执行操作，请分段再说一次。'; } : dismiss ? async function* () { yield current.voiceFarewellText?.trim() ?? IDLE_FAREWELL; } : createNativeSharedChat({ baseUrl: options.chatBaseUrl,
        voicePresentation:true,
        settings: () => ({ routingMode: current.routingMode, projectId: current.projectId, conversationId, voicePrefetchToken, deviceId: options.deviceId, voiceChatModel: current.voiceChatModel, voiceReasoningEffort: current.voiceReasoningEffort }),
        onConversation: id => { context.signal.throwIfAborted(); options.conversation.save(id); },
        onProgress: event => { progress.accept(event); },
        onNavigation:options.onNavigation,onActivity:options.onActivity,captureCameraFrame:options.captureCameraFrame,
        playbackContext: options.playbackContext,
        onAnswer: (id,hash,messageId) => options.onAnswer?.({generation:context.key.workerGeneration,audioGeneration:context.key.audioGeneration,turn:context.key.turn},id,hash,messageId)
      });
      return createNativeResponsePipeline({ answer, player, beforeAudio: () => audioGate ?? Promise.resolve(), overlapAnswerStartup: current.routingMode === 'life' && !dismiss,
        onStage:stage=>options.onResponseStage?.({generation:context.key.workerGeneration,audioGeneration:context.key.audioGeneration,turn:context.key.turn},stage),
        onFailureCode:code=>options.onResponseFault?.({generation:context.key.workerGeneration,audioGeneration:context.key.audioGeneration,turn:context.key.turn},code),
        onDeviceReceipt: receipt => {
          const frames=(receipt as {renderedFrames?:number}|null)?.renderedFrames;
          if(Number.isSafeInteger(frames)&&frames!>0)options.onPlaybackReceipt?.({generation:context.key.workerGeneration,audioGeneration:context.key.audioGeneration,turn:context.key.turn},frames!);
        },
        onAudioPacket: (kind,bytes) => options.onAudioPacket?.({generation:context.key.workerGeneration,audioGeneration:context.key.audioGeneration,turn:context.key.turn},kind,bytes),
        progress: cachedProgress && !dismiss && !progressCommand && current.routingMode !== 'life' && current.voiceProgressMode !== 'off' ? { finish: () => progress.finish(), next() {
          const item = progress.next(); if (!item) return null;
          let pcm: Buffer | null = null;
          try { pcm = cachedProgress?.(current, item.event.stage) ?? null; } catch { return null; }
          return pcm ? { pcm, current: () => progress.canPlay(item.event), started: () => progress.started(item.event) } : null;
        } } : undefined,
        synthesize: signal => (options.connectTts ?? createQwenRealtimeTts)({
        baseUrl: current.synthesisBaseUrl, model: current.synthesisModel, voice: current.voice, speechRate: current.voiceSpeechRate ?? 1,
        apiKey: currentKeys.synthesis, signal,
        onMetric:metric=>options.onSynthesisMetric?.({generation:context.key.workerGeneration,audioGeneration:context.key.audioGeneration,turn:context.key.turn},metric)
      }) })(context);
    },
    onStatus(event) {
      if (event.type === 'failed' || event.type === 'finished') prefetch.cancel();
      options.onStatus?.(event);
    },
    onRecognition(event) {
      if (event.type === 'partial' && snapshot) prefetch.partial(turnId(event), event.text, { ...snapshot, conversationId: options.conversation.read() });
      if (event.type === 'failed') prefetch.cancel();
      options.onRecognition?.(event);
    }
  });
  return {
    configure() { cache?.busy(); }, // Current turn keeps its snapshot; no prewarm after disabling.
    async start() {
      validate(options.settings()); getKey('recognition'); getKey('synthesis');
      if (startupSessionCloses) { for (const payload of startupSessionCloses) queueSessionClose(payload); startupSessionCloses = undefined; }
      return owner.start();
    },
    stop: () => { prefetch.cancel(); cache?.busy(); retireCandidate(); return owner.stop(); },
    async close() {
      prefetch.cancel(); cache?.close(); interruption.close(); retireCandidate();
      audioWorker.off('event', interruptionEvent); audioWorker.off('fault', workerRetired); audioWorker.off('closed', workerRetired);
      await owner.close();
    }
  };
}
