import { EventEmitter } from 'node:events';
import { VoiceAsrTurnBridge, type AudioTurn, type VoiceAsrBridgeDependencies } from './voice-asr-turn-bridge.js';
import { configuredRealtimeAsrFactory, validateRealtimeRecognition, type TrustedRecognitionSettings } from './configured-realtime-asr.js';

export type NativeAudioPacket = AudioTurn & { sequence: number; pcm: Buffer; capturedAt: number };
export type NativeAudioWorker = EventEmitter & { start(): Promise<{ generation: number }>; stop(): Promise<void> };
type Packet = NativeAudioPacket;
type Worker = NativeAudioWorker;
type Lifecycle = { type: 'start' | 'cancel' | 'idle-farewell' | 'voice-preview' | 'utterance-limit'; key: AudioTurn; reason?: string } | { type: 'retire'; generation: number };

export function createConfiguredNativeRecognitionOwner(createWorker: (consume: (packet: Packet) => boolean) => Worker, settings: TrustedRecognitionSettings, onEvent: VoiceAsrBridgeDependencies['onEvent']) {
  const owner = createNativeRecognitionOwner(createWorker, { createSession: configuredRealtimeAsrFactory(settings), onEvent });
  return { ...owner, async start() {
    validateRealtimeRecognition(settings.current());
    if (!settings.effectiveApiKey()) throw new Error('ASR_KEY_NOT_CONFIGURED');
    return owner.start();
  } };
}

/** Composition boundary for the trusted supervisor, PCM channel and cloud ASR.
 * createWorker must enable --stream-pcm/--control-stdin; no renderer-supplied arguments.
 * Does not automatically execute tools or synthesize a reply from recognized text.
 */
export function createNativeRecognitionOwner(createWorker: (consume: (packet: Packet) => boolean) => Worker, dependencies: VoiceAsrBridgeDependencies & { onLifecycle?: (event: Lifecycle) => void }) {
  const bridge = new VoiceAsrTurnBridge(dependencies);
  const worker = createWorker(packet => bridge.append(packet, packet.sequence, packet.pcm, packet.capturedAt));
  let generation: number | undefined;
  let closed = false;
  const onEvent = (event: { type: string; generation: number; audioGeneration?: number; turn?: number; frameCount?: number; reason?: string }) => {
    if (closed) return;
    if (event.type === 'ready') { generation = event.generation; return; }
    if (event.generation !== generation) return;
    const key = { workerGeneration: event.generation, audioGeneration: event.audioGeneration!, turn: event.turn! };
    if (event.type === 'turn-start') { dependencies.onLifecycle?.({ type: 'start', key, reason: event.reason }); bridge.start(key); }
    if ((event.type === 'idle-farewell' || event.type === 'voice-preview') && bridge.reserveControlTurn(key)) dependencies.onLifecycle?.({ type: event.type, key });
    if (event.type === 'turn-end') {
      if (event.reason === 'max-duration') { bridge.cancel(key); dependencies.onLifecycle?.({ type: 'utterance-limit', key }); }
      else bridge.finish(key, event.frameCount!);
    }
    if (event.type === 'turn-cancelled' || event.type === 'standby') { dependencies.onLifecycle?.({ type: 'cancel', key }); bridge.cancel(key); }
  };
  const retire = (event: { generation: number }) => {
    dependencies.onLifecycle?.({ type: 'retire', generation: event.generation });
    bridge.stopWorker(event.generation);
    if (generation === event.generation) generation = undefined;
  };
  worker.on('event', onEvent); worker.on('fault', retire); worker.on('closed', retire);
  return {
    worker,
    cancelRecognition(key: AudioTurn) { return bridge.cancel(key); },
    start() { if (closed) return Promise.reject(new Error('VOICE_OWNER_CLOSED')); return worker.start(); },
    async stop() { if (generation !== undefined) retire({ generation }); await worker.stop(); },
    async close() {
      closed = true; if (generation !== undefined) retire({ generation }); bridge.close();
      try { await worker.stop(); } finally { worker.off('event', onEvent); worker.off('fault', retire); worker.off('closed', retire); }
    }
  };
}
