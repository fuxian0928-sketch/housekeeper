const { voiceProcessingArgs } = require('./voice-processing-config.cjs');
const { readVoiceFarewell } = require('./voice-farewell-config.cjs');
const { readWakeWord } = require('./assistant-identity.cjs');
const { verifyNativeVoiceRuntime } = require('./native-voice-runtime-check.cjs');
const { verifyNativeVoiceAssets } = require('./native-voice-assets.cjs');
const { readVoicePrefetch } = require('./voice-prefetch-config.cjs');
const { createVoiceStageTiming } = require('./voice-stage-timing.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { VoiceWorkerSupervisor } = require('./voice-worker-supervisor.cjs');
const { readVoiceSynthesis } = require('./voice-synthesis-config.cjs');
const { readVoiceTiming } = require('./voice-timing-config.cjs');
const { readVoiceProgress } = require('./voice-progress-config.cjs');
const { NativePlayback } = require('./native-playback.cjs');
const { createPlaybackStore } = require('./voice-playback-store.cjs');
const { NativePlaybackLedger } = require('./native-playback-ledger.cjs');
const { createDeviceRecovery } = require('./voice-device-recovery.cjs');
const { saveJsonAtomically } = require('./atomic-json-store.cjs');

// Explicit development host. This is never configured through renderer IPC.
async function createNativeVoiceHost({ configFile, appRoot, workerRoot = appRoot, resourceBundleRoot, dataDirectory, deviceId, port, readCompanionConfig, readConnection, key, onStatus, onPlaybackLevel, onStartupStage, onNavigation,onActivity,onComputerControl,captureCameraFrame,readDevices, prepareKeywords = require('./native-wake-keywords.cjs').prepareNativeWakeKeywords, verifyAssets = verifyNativeVoiceAssets, verifyRuntime = verifyNativeVoiceRuntime, loadRuntime = async () => import(pathToFileURL(path.join(appRoot, 'build/server/providers/native-voice-runtime.js')).href) }) {
  onStartupStage?.('resources');
  const bundle = resourceBundleRoot ? await require('./native-voice-bundle.cjs').verifyNativeVoiceBundle(resourceBundleRoot) : null;
  if (bundle) workerRoot = bundle.workerRoot;
  const input = { ...(bundle || JSON.parse(fs.readFileSync(configFile, 'utf8'))), ...(readDevices ? readDevices() : {}) };
  for (const field of ['python', 'model', 'keywords']) {
    if (typeof input[field] !== 'string' || !path.isAbsolute(input[field]) || !fs.existsSync(input[field])) throw Error('VOICE_NATIVE_ASSET_MISSING');
  }
  for (const field of ['inputName', 'outputName']) if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 200) throw Error('VOICE_NATIVE_DEVICE_MISSING');
  await verifyAssets({ appRoot: workerRoot, model: input.model });
  onStartupStage?.('runtime');
  await verifyRuntime({ appRoot: workerRoot, python: input.python, inputName: input.inputName, outputName: input.outputName });
  onStartupStage?.('wake');
  input.keywords = prepareKeywords({config:readCompanionConfig(),model:input.model,dataDirectory});
  const { createNativeVoiceRuntime } = await loadRuntime();
  const initialConnection = readConnection ? readConnection() : input.connection;
  let localSpeech;
  const historyPath = path.join(dataDirectory, 'native-voice-history.json');
  const pendingPath = path.join(dataDirectory, 'native-voice-close-pending.json');
  const resolvedDeviceId = deviceId || require('./voice-client-id.cjs').readVoiceClientId(dataDirectory);
  let pendingCloses = new Map();
  try {
    const value = JSON.parse(fs.readFileSync(pendingPath, 'utf8')).pending;
    if (!Array.isArray(value) || value.length > 100 || value.some(item =>
      typeof item?.conversationId !== 'string' || !item.conversationId || item.conversationId.length > 200 ||
      !['life','work','auto'].includes(item.routingMode) ||
      (item.projectId !== null && typeof item.projectId !== 'string'))) throw Error('VOICE_SESSION_OUTBOX_INVALID');
    for (const item of value) pendingCloses.set(item.conversationId, { conversationId:item.conversationId, routingMode:item.routingMode, projectId:item.projectId });
  } catch (error) { if (fs.existsSync(pendingPath)) throw Error('VOICE_SESSION_OUTBOX_INVALID'); }
  const storePending = payload => {
    if (pendingCloses.has(payload.conversationId)) return;
    if (pendingCloses.size >= 100) throw Error('VOICE_SESSION_OUTBOX_FULL');
    const next = new Map(pendingCloses);
    next.set(payload.conversationId, payload);
    saveJsonAtomically(pendingPath, { pending:[...next.values()] });
    pendingCloses = next;
  };
  const acknowledgePending = conversationId => {
    if (!pendingCloses.has(conversationId)) return;
    const next = new Map(pendingCloses);
    next.delete(conversationId);
    saveJsonAtomically(pendingPath, { pending:[...next.values()] });
    pendingCloses = next;
  };
  const closeScope = () => {
    const config = readCompanionConfig();
    const routingMode = ['life','work','auto'].includes(config.voiceRoutingMode) ? config.voiceRoutingMode : 'life';
    return { routingMode, projectId:routingMode === 'life' ? null : config.voiceProjectId || null };
  };
  // A process restart is a new wake session. Close the previous archive without
  // reviving its active ID; the runtime retries before the next chat if needed.
  let previousHistory = null;
  try { const value = JSON.parse(fs.readFileSync(historyPath, 'utf8')).id; if (typeof value === 'string' && value.length > 0 && value.length <= 200) previousHistory = value; } catch {}
  if (previousHistory) storePending({ conversationId:previousHistory, ...closeScope() });
  let history = null;
  if (previousHistory) fs.rmSync(historyPath, { force:true });
  let running = false, closed = false, serial = Promise.resolve(), activeWorker = null, everStarted = false;
  let recovery;
  const timing = createVoiceStageTiming(path.join(dataDirectory,'logs/native-voice-stages.json'));
  const playbackLedger = new NativePlaybackLedger();
  const playbackStore = createPlaybackStore(path.join(dataDirectory, 'native-voice-playback.json'));
  const persistPlayback = () => playbackStore.update(playbackLedger.snapshot());
  const enabled = () => { const c = readCompanionConfig(); return !closed && c.voiceEnabled !== false && !c.mockMode; };
  if (initialConnection?.speechExecution === 'local') {
    onStartupStage?.('speech-models');
    localSpeech = require('./local-speech-provider.cjs').createLocalSpeechProvider({
      python: input.python, workerRoot, modelRoot: path.join(workerRoot, 'speech-models'),
      onFault: () => onStatus?.({ type: 'failed', code: 'VOICE_LOCAL_PROCESS_FAILED' })
    });
    try { await localSpeech.ready; } catch (error) { await localSpeech.close(); throw error; }
  }
  let runtime;
  try { runtime = createNativeVoiceRuntime({
    settings() {
      const companion = readCompanionConfig();
      const connection = readConnection ? readConnection() : input.connection;
      if ((connection?.speechExecution === 'local') !== Boolean(localSpeech)) throw Error('VOICE_LOCAL_PROFILE_CHANGED');
      return { ...connection, ...readVoiceFarewell(companion), ...readVoiceSynthesis(companion), ...(connection?.speechExecution === 'local' ? {voiceSpeechRate:1} : {}), ...readVoiceProgress(companion), ...readVoicePrefetch(companion), wakeWord: readWakeWord(companion), routingMode: companion.voiceRoutingMode || 'auto', projectId: companion.voiceProjectId || null, voiceChatModel: companion.voiceChatModel || '', voiceReasoningEffort: companion.voiceReasoningEffort || 'follow' };
    }, key, ...(localSpeech ? {connectAsr:localSpeech.connectAsr,connectTts:localSpeech.connectTts} : {}), chatBaseUrl: `http://127.0.0.1:${port}`, deviceId: resolvedDeviceId,onNavigation,onActivity,onComputerControl,captureCameraFrame,
    initialSessionCloses: [...pendingCloses.values()], onSessionCloseAcknowledged: acknowledgePending,
    conversation: {
      read: () => history,
      save(id) { saveJsonAtomically(historyPath, { id }); history = id; },
      clear() {
        const previous = history;
        if (!previous) return null;
        storePending({ conversationId:previous, ...closeScope() });
        // Removing the active pointer is atomic; archived DB conversations remain intact.
        fs.rmSync(historyPath, { force:true });
        history = null;
        return previous;
      }
    },
    createWorker: (audioConsumer, interruptionConsumer) => {
      const worker = new VoiceWorkerSupervisor({ executable: input.python, cwd: workerRoot,
      args: ['-E', '-s', '-B', path.join(workerRoot, 'scripts/voice-lab/run_duplex.py'), '--model', input.model, '--keywords', input.keywords,
        '--input-name', input.inputName, '--output-name', input.outputName, '--continuous', '--control-stdin', '--stream-pcm', '--wake-feedback',
        ...(interruptionConsumer ? ['--interruption-capture'] : []),
        ...voiceProcessingArgs(readCompanionConfig()),
        '--report', path.join(dataDirectory, 'logs/native-voice-session.json')], audioConsumer, interruptionConsumer });
      activeWorker = worker;
      worker.on('event', event => {
        timing.mark(event,event.type);
        if(['playback-progress','playback-submitted'].includes(event.type)){
          timing.mark(event,'device-first-frame');
          if(event.health)timing.record(event,'playback-health',{startupMs:event.health.startupFrames*10,pausedMs:event.health.pausedFrames*10,underrunMs:event.health.underrunFrames*10,underrunCount:event.health.underrunCount,queuedMs:event.health.queuedFrames*10,
            ...Object.fromEntries(['deviceOutputUnderflows','deviceInputOverflows','deviceLateCallbacks','deviceMaxGapMs','headOutputUnderflows','headLateCallbacks','headMaxGapMs'].map(name=>[name,event.health[name]]))});
        }
        playbackLedger.observe(event); persistPlayback();
        if (event.type === 'ready') {
          worker.configureTiming(readVoiceTiming(readCompanionConfig()));
          worker.configureWake(readCompanionConfig().wakeWordEnabled !== false);
        }
        if (event.type === 'listening' || event.type === 'standby' || event.type === 'wake') onStatus?.(event);
      });
      worker.on('closed', event => { playbackLedger.freeze('device-closed',event?.generation); persistPlayback(); running = false; });
      worker.on('fault', event => { playbackLedger.freeze('device-error',event?.generation); persistPlayback(); running = false; onStatus?.({ type: 'failed', code: 'VOICE_DEVICE_FAILED' }); if (everStarted) recovery?.fault(); });
      return worker;
    },
      createPlayer: worker => new NativePlayback(worker,{readVolume:()=>readCompanionConfig().speechVolume ?? 100,leadMs:localSpeech?900:500,onLevel:onPlaybackLevel}), prewarmProgress: true,
      onResponseStage:(key,stage)=>timing.mark(key,stage),
      onSynthesisMetric:(key,metric)=>timing.record(key,metric.stage,metric.values),
      onResponseFault:(key,code)=>{
        if (!/^(?:TTS_[A-Z_]+|VOICE_TTS_REJECTED|PLAYBACK_[A-Z_]+|VOICE_PLAYBACK_[A-Z_]+|OTHER)$/.test(code)) return;
        try {
          const log = path.join(dataDirectory, 'logs/native-voice-faults.log');
          if (fs.existsSync(log) && fs.statSync(log).size > 200_000) fs.writeFileSync(log, '');
          fs.appendFileSync(log, `${new Date().toISOString()} generation=${key.generation} turn=${key.turn} code=${code}\n`);
        } catch {}
      },
      onRecognition:event=>{if(['final','failed'].includes(event.type))timing.mark({generation:event.workerGeneration,audioGeneration:event.audioGeneration,turn:event.turn},event.type==='final'?'asr-final':'asr-failed');},
      onAudioPacket: (key,kind,bytes) => playbackLedger.offer(key,kind,bytes), onStatus:event=>{
        if(['failed','finished'].includes(event.type))timing.mark({generation:event.workerGeneration,audioGeneration:event.audioGeneration,turn:event.turn,code:event.code},event.type==='failed'?'turn-failed':'turn-finished');
        onStatus?.(event);
      },
      onPlaybackReceipt: (key,frames) => { playbackLedger.complete(key,frames); persistPlayback(); },
      onAnswer: (key,id,hash,messageId) => { playbackLedger.bind(key,id,hash,messageId); persistPlayback(); },
      playbackContext: id => playbackLedger.context(id) ?? playbackStore.context(id)
  });
  } catch (error) { await localSpeech?.close(); throw error; }
  recovery = createDeviceRecovery({ enabled, onStatus, restart() {
    serial = serial.catch(() => {}).then(async () => {
      // Stop first: retire cloud requests and await the old device process closing.
      await runtime.stop(); running = false;
      if (!enabled()) return;
      await verifyAssets({ appRoot: workerRoot, model: input.model });
      if (!enabled()) return;
      await runtime.start(); running = true;
    });
    return serial;
  } });
  const reconcile = () => {
    serial = serial.catch(() => {}).then(async () => {
      if (closed) return;
      const shouldRun = enabled();
      if (shouldRun && !running) {
        recovery.cancel();
        if (everStarted) await runtime.stop();
        if (!enabled()) return;
        await verifyAssets({ appRoot: workerRoot, model: input.model });
        if (!enabled()) return;
        onStartupStage?.('audio-device');
        await runtime.start(); running = true; everStarted = true; onStatus?.({ type: 'recovered' });
      } else if (shouldRun && running) {
        runtime.configure?.();
        if (!activeWorker?.configureTiming(readVoiceTiming(readCompanionConfig()))) throw Error('VOICE_TIMING_NOT_APPLIED');
        if (!activeWorker?.configureWake(readCompanionConfig().wakeWordEnabled !== false)) throw Error('VOICE_WAKE_SETTING_NOT_APPLIED');
      } else if (!shouldRun) {
        recovery.cancel();
        await runtime.stop(); running = false;
      }
    });
    return serial;
  };
  return { reconcile, status: () => ({ running, closed }), connectionSnapshot: () => ({
    settings: { ...(readConnection ? readConnection() : input.connection) },
    keys: { recognition: key('recognition'), synthesis: key('synthesis') }
  }), clearTiming:()=>timing.clear(), timingStatus:()=>timing.snapshot(), playbackStatus: () => playbackLedger.snapshot(), playbackStorageStatus: () => playbackStore.status(), control(action) {
    if (closed || !running || !['wake', 'dismiss', 'preview'].includes(action)) return false;
    return activeWorker?.sessionControl(action === 'preview' ? 'voice-preview' : action === 'wake' ? 'manual-wake' : 'manual-dismiss') ?? false;
  }, async close() { closed = true; recovery.close(); await serial.catch(() => {}); try { await runtime.close(); } finally { await localSpeech?.close(); } playbackLedger.freeze('device-closed'); persistPlayback(); await playbackStore.flush();await timing.flush(); running = false; } };
}
module.exports = { createNativeVoiceHost };
