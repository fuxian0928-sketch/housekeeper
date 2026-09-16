import { api as chatApi } from '../../api';
import { requestTranscript, withVoiceDeadline } from './voice-request';
import { createVoiceFeedback, type FeedbackClips } from './voice-feedback';
import { useEffect, useRef, useState } from 'react';
import { wakeWordScore } from './wake-word';
import { createSpeechGate, listenForTranscript, listenUntilIdle, isDismissCommand, IDLE_FAREWELL, NoSpeechError } from './voice-listening';
import xiaoEAvatar from '../../assets/xiao-e-avatar.png';
import xiaoEDesktop from '../../assets/xiao-e-desktop.png';
import type { CompanionConfig, CompanionState } from './types';

// Timings only: never log recordings, transcripts, credentials or camera frames.
const voiceTiming = (stage: string, started: number) => console.info('[voice-timing]', JSON.stringify({ stage, ms: Math.round(performance.now() - started) }));
const voiceFailure = (stage: string, error: unknown) => console.info('[voice-error]', JSON.stringify({ stage, code: error instanceof DOMException ? error.name : error instanceof TypeError ? 'NetworkError' : 'ServiceError' }));

const stateCopy: Record<CompanionState, string> = {
  idle: '小E在这里',
  waking: '我听见啦',
  listening: '正在听你说',
  thinking: '让我想一想',
  speaking: '小E正在说话',
  notifying: '有件事想告诉你',
  camera: '正在看向你'
};

const fallbackConfig: CompanionConfig = {
  enabled: false,
  alwaysOnTop: true,
  appearance: 'character',
  iconSize: 64,
  characterHeight: 240,
  opacity: 1,
  motion: 'full',
  launchAtStartup: false,
  idleHideMinutes: 0,
  mockMode: true,
  wakeWordEnabled: false,
  wakeWord: '小E小E',
  wakeWordThreshold: .66
};

export function DesktopCompanion() {
  const [state, setState] = useState<CompanionState>('idle');
  const [config, setConfig] = useState<CompanionConfig>(fallbackConfig);
  const [statusText, setStatusText] = useState('');
  const busy = useRef(false);
  const feedbackClips = useRef<FeedbackClips>({});
  const warmingFeedback = useRef(false);
  const phase = useRef<CompanionState>('idle');
  const voiceRunner = useRef<(dismiss?: boolean) => Promise<void>>(async () => {});
  const wakeAbort = useRef<AbortController | null>(null);
  const turnAbort = useRef<AbortController | null>(null);
  const recordingDone = useRef<Promise<unknown> | null>(null);
  const turnId = useRef(0);
  const clickTimer = useRef<number | null>(null);
  const drag = useRef<{ startX: number; startY: number; offsetX: number; offsetY: number; moved: boolean } | null>(null);
  const dragFrame = useRef<number | null>(null);
  const pendingMove = useRef<{ screenX: number; screenY: number; offsetX: number; offsetY: number } | null>(null);
  const suppressClick = useRef(false);
  const activeRecorder = useRef<MediaRecorder | null>(null);
  const activeAudio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    document.documentElement.dataset.surface = 'companion';
    const api = window.aiSecretary?.companion;
    if (!api) return () => { delete document.documentElement.dataset.surface; };
    void api.getConfig().then(setConfig);
    void api.getState().then(setState);
    const stopState = api.onStateChanged(setState);
    const stopConfig = api.onConfigChanged(setConfig);
    return () => {
      stopState();
      stopConfig();
      delete document.documentElement.dataset.surface;
    };
  }, []);

  const updateState = async (next: CompanionState) => {
    phase.current = next;
    setState(next);
    await window.aiSecretary?.companion.setState(next);
  };

  const captureCameraFrame = async (signal: AbortSignal) => {
    if (!config.cameraContextEnabled || !navigator.mediaDevices?.getUserMedia) return null;
    const stream = await navigator.mediaDevices.getUserMedia({ video: config.cameraDeviceId ? { deviceId: { exact: config.cameraDeviceId }, width: { ideal: 640 }, height: { ideal: 360 } } : { width: { ideal: 640 }, height: { ideal: 360 } }, audio: false });
    const stop = () => stream.getTracks().forEach(track => track.stop());
    signal.addEventListener('abort', stop, { once: true });
    try {
      signal.throwIfAborted();
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      if (video.readyState < 2) await new Promise<void>(resolve => video.addEventListener('loadeddata', () => resolve(), { once: true }));
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', .72);
    } finally { signal.removeEventListener('abort', stop); stop(); }
  };

  const speakableText = (value: string) => value
    .replace(/```[\s\S]*?```/g, '这里有一段代码，已显示在聊天记录中。')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);

  const blobAsDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('无法读取麦克风录音。'));
    reader.readAsDataURL(blob);
  });

  const captureSpeech = async (signal?: AbortSignal) => {
    const recordingStarted = performance.now();
    signal?.throwIfAborted();
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('当前环境不支持云端语音识别。');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: config.microphoneDeviceId ? { deviceId: { exact: config.microphoneDeviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (signal?.aborted) { stream.getTracks().forEach(track => track.stop()); signal.throwIfAborted(); }
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type)) || '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    activeRecorder.current = recorder;
    const chunks: BlobPart[] = [];
    const context = new AudioContext();
    await context.resume().catch(error => { stream.getTracks().forEach(track => track.stop()); void context.close(); throw error; });
    if (signal?.aborted) { stream.getTracks().forEach(track => track.stop()); void context.close(); signal.throwIfAborted(); }
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let heardVoice = false;
    let frame = 0;
    const startedAt = performance.now();
    const speechGate = createSpeechGate(startedAt);
    const stopped = new Promise<Blob>((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => reject(new Error('麦克风录音失败。'));
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    });
    const stop = () => { if (recorder.state === 'recording') recorder.stop(); };
    signal?.addEventListener('abort', stop, { once: true });
    const watchSilence = () => {
      if (recorder.state !== 'recording') return;
      analyser.getByteTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
      const level = Math.sqrt(energy / samples.length);
      const now = performance.now();
      const gate = speechGate(level, now);
      heardVoice = gate.heardVoice;
      if (gate.stop) stop();
    };
    try {
      signal?.throwIfAborted();
      recorder.start(180);
      frame = window.setInterval(watchSilence, 40);
      const blob = await stopped;
      voiceTiming('recording', recordingStarted);
      signal?.throwIfAborted();
      if (!heardVoice || blob.size < 800) throw new NoSpeechError();
      return await blobAsDataUrl(blob);
    } finally {
      window.clearInterval(frame);
      signal?.removeEventListener('abort', stop);
      if (activeRecorder.current === recorder) activeRecorder.current = null;
      stream.getTracks().forEach(track => track.stop());
      void context.close();
    }
  };

  // Serialize microphone acquisition, including permission/setup and track cleanup.
  const recordCloudSpeech = (signal?: AbortSignal): Promise<string> => {
    const previous = recordingDone.current;
    const recording = (async () => {
      await previous;
      signal?.throwIfAborted();
      return captureSpeech(signal);
    })();
    const settled = recording.then(() => undefined, () => undefined);
    recordingDone.current = settled;
    void settled.then(() => { if (recordingDone.current === settled) recordingDone.current = null; });
    return recording;
  };

  const recognizeTurn = async (signal: AbortSignal) => listenForTranscript(
    () => recordCloudSpeech(signal),
    async audioDataUrl => {
      setStatusText('正在识别…');
      const started = performance.now();
      const text = await requestTranscript(audioDataUrl, signal);
      voiceTiming('asr', started);
      return text;
    },
    () => setStatusText('请说，我还在听'),
    signal,
  );

  const warmFeedback = async () => {
    if (warmingFeedback.current) return;
    warmingFeedback.current = true;
    try {
      const result = await fetch('/api/speech/feedback', {method: 'POST', signal: AbortSignal.timeout(90_000)});
      if (result.ok) feedbackClips.current = await result.json() as FeedbackClips;
    } catch { /* Optional feedback must not block conversation. */ }
    finally { warmingFeedback.current = false; }
  };

  const playAudio = async (audioDataUrl: string, signal: AbortSignal) => {
    const started = performance.now();
    signal.throwIfAborted();
      const audio = new Audio(audioDataUrl);
      activeAudio.current = audio;
      try {
        await new Promise<void>((resolve, reject) => {
          const clean = () => { signal.removeEventListener('abort', abort); audio.onended = null; audio.onerror = null; audio.onplaying = null; };
          const abort = () => { audio.pause(); clean(); reject(signal.reason ?? new DOMException('已打断', 'AbortError')); };
          audio.onplaying = () => voiceTiming('playback-start', started);
          audio.onended = () => { clean(); resolve(); };
          audio.onerror = () => { clean(); reject(new Error('合成音频无法播放。')); };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) { abort(); return; }
          void audio.play().catch(error => { clean(); reject(error); });
        });
      } finally { if (activeAudio.current === audio) activeAudio.current = null; }
  };

  const speakTurn = async (text: string, signal: AbortSignal) => {
    const started = performance.now();
    signal.throwIfAborted();
    try {
      const result = await fetch('/api/speech/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      const payload = await result.json() as { audioDataUrl?: string; message?: string };
      signal.throwIfAborted();
      voiceTiming('tts-ready', started);
      if (!result.ok || !payload.audioDataUrl) throw new Error(payload.message || '云端语音合成失败。');
      await playAudio(payload.audioDataUrl, signal);
      voiceTiming('playback-end', started);
    } catch (error) {
      signal.throwIfAborted();
      voiceFailure('tts-fallback', error);
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          void window.aiSecretary?.companion.stopSpeech();
          reject(signal.reason ?? new DOMException('已打断', 'AbortError'));
        };
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) { stop(); return; }
        void window.aiSecretary?.companion.speak(text).then(local => {
          signal.removeEventListener('abort', stop);
          if (signal.aborted) return;
          if (local.ok) resolve();
          else reject(new Error(local.message || '语音播报失败。'));
        }, error => { signal.removeEventListener('abort', stop); reject(error); });
      });
    }
  };

  const runVoiceTurn = async (dismiss = false) => {
    const api = window.aiSecretary?.companion;
    if (!api) return;
    void warmFeedback();
    turnAbort.current?.abort();
    wakeAbort.current?.abort();
    const currentTurn = ++turnId.current;
    busy.current = true;
    phase.current = 'listening';
    const controller = new AbortController();
    turnAbort.current = controller;
    wakeAbort.current?.abort();
    const retire = async () => {
      setStatusText(IDLE_FAREWELL);
      await updateState('speaking');
      await speakTurn(IDLE_FAREWELL, controller.signal);
      if (currentTurn !== turnId.current) return;
      setStatusText('');
      await updateState('idle');
    };
    try {
      await api.stopSpeech();
      if (currentTurn !== turnId.current) return;
      if (dismiss) { await retire(); return; }
      while (!controller.signal.aborted && currentTurn === turnId.current) {
        phase.current = 'listening';
        wakeAbort.current?.abort();
        await recordingDone.current;
        controller.signal.throwIfAborted();
        setStatusText('请说，我在听');
        await updateState('listening');
        const recognizedText = await listenUntilIdle(recognizeTurn, controller.signal);
        if (currentTurn !== turnId.current) return;
        if (recognizedText === null || isDismissCommand(recognizedText)) {
          await retire();
          return;
        }
        setStatusText(`你说：${recognizedText}`);
        await updateState('thinking');
        const cameraFrame = await withVoiceDeadline(captureCameraFrame, controller.signal, 4000).catch(() => null);
        controller.signal.throwIfAborted();
        const conversationId = localStorage.getItem('ai-secretary-companion-voice-conversation-id');
        const chatStarted = performance.now();
        const feedback = createVoiceFeedback({
          signal: controller.signal, clips: () => feedbackClips.current,
          play: (clip, signal) => playAudio(clip.audioDataUrl, signal)
        });
        let payload: { answer?: string; conversationId?: string } = {};
        try {
          await chatApi.stream('/chat/stream', {
            message: recognizedText,
            scope: 'global',
            projectId: null,
            conversationId: conversationId || null,
            cameraFrame,
            reasoningEffort: 'low',
            interactionMode: 'voice',
            clientVersion: '1.0.0'
          }, event => {
            controller.signal.throwIfAborted();
            feedback.onEvent(event);
            if (event.type === 'error' || event.type === 'cancelled') throw new Error(String(event.message || '这次对话没有完成。'));
            if (event.type === 'done') payload = event;
          }, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]));
          if (!payload.answer) throw new Error('小E暂时没有返回回答。');
          await feedback.finish();
        } finally { feedback.cancel(); }
        voiceTiming('chat', chatStarted);
        if (currentTurn !== turnId.current) return;
        if (payload.conversationId) localStorage.setItem('ai-secretary-companion-voice-conversation-id', payload.conversationId);
        setStatusText(payload.answer.length > 64 ? `${payload.answer.slice(0, 64)}…` : payload.answer);
        await updateState('speaking');
        await speakTurn(speakableText(payload.answer), controller.signal);
        if (currentTurn !== turnId.current) return;
      }
    } catch (error) {
      if (currentTurn !== turnId.current) return;
      if (error instanceof NoSpeechError || controller.signal.aborted) { setStatusText(''); await updateState('idle'); return; }
      voiceFailure(`turn-${phase.current}`, error);
      setStatusText(error instanceof DOMException && error.name === 'TimeoutError' ? '等待语音超时，叫我可以继续。' : error instanceof Error ? error.message : '这次对话没有完成。');
      await updateState('notifying');
      window.setTimeout(() => { if (!busy.current) { setStatusText(''); void updateState('idle'); } }, 3500);
    } finally { if (currentTurn === turnId.current) { busy.current = false; turnAbort.current = null; } }
  };

  voiceRunner.current = runVoiceTurn;

  useEffect(() => {
    if (config.mockMode || config.wakeWordEnabled === false) return;
    void warmFeedback();
    let cancelled = false;
    const wait = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds));
    const monitor = async () => {
      while (!cancelled) {
        if (busy.current && !['thinking','speaking'].includes(phase.current)) { await wait(150); continue; }
        try {
          const controller = new AbortController();
          wakeAbort.current = controller;
          const audioDataUrl = await recordCloudSpeech(controller.signal);
          if (cancelled || controller.signal.aborted) continue;
          const started = performance.now();
          const payload = { text: await requestTranscript(audioDataUrl, controller.signal) };
          voiceTiming('wake-asr', started);
          if (cancelled || controller.signal.aborted) continue;
          if (busy.current && payload.text && isDismissCommand(payload.text)) { void voiceRunner.current(true); continue; }
          if (!payload.text || wakeWordScore(payload.text, config.wakeWord || '小E小E') < (config.wakeWordThreshold ?? .66)) continue;
          if (busy.current) { void voiceRunner.current(); continue; }
          busy.current = true;
          setStatusText('我在，请说');
          await updateState('waking');
          try { await speakTurn('我在，请说。', controller.signal); } finally { if (!controller.signal.aborted) busy.current = false; }
          if (!cancelled && !controller.signal.aborted) void voiceRunner.current();
        } catch (error) {
          if (!cancelled && !busy.current && !(error instanceof DOMException && error.name === 'AbortError')) {
            const message = error instanceof Error ? error.message : '唤醒监听异常';
            if (!(error instanceof NoSpeechError)) { voiceFailure('wake', error); setStatusText(message); }
          }
          if (!cancelled) await wait(700);
        }
      }
    };
    void monitor();
    return () => {
      cancelled = true;
      ++turnId.current;
      wakeAbort.current?.abort();
      turnAbort.current?.abort();
      busy.current = false;
      phase.current = 'idle';
    }; 
  }, [config.mockMode, config.wakeWordEnabled, config.wakeWord, config.wakeWordThreshold, config.microphoneDeviceId]);

  const beginListening = () => {
    if (clickTimer.current) window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      void runVoiceTurn();
    }, 220);
  };

  const openMain = () => {
    if (clickTimer.current) window.clearTimeout(clickTimer.current);
    clickTimer.current = null;
    void window.aiSecretary?.companion.openMain('chat');
  };

  const beginDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    drag.current = { startX: event.screenX, startY: event.screenY, offsetX: event.clientX, offsetY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const continueDrag = (event: React.PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    if (!current.moved && Math.hypot(event.screenX - current.startX, event.screenY - current.startY) < 4) return;
    current.moved = true;
    pendingMove.current = { screenX: event.screenX, screenY: event.screenY, offsetX: current.offsetX, offsetY: current.offsetY };
    if (dragFrame.current !== null) return;
    dragFrame.current = window.requestAnimationFrame(() => {
      dragFrame.current = null;
      if (pendingMove.current) window.aiSecretary?.companion.moveToPointer(pendingMove.current);
      pendingMove.current = null;
    });
  };

  const endDrag = () => {
    if (dragFrame.current !== null) window.cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    if (pendingMove.current) window.aiSecretary?.companion.moveToPointer(pendingMove.current);
    pendingMove.current = null;
    suppressClick.current = Boolean(drag.current?.moved);
    drag.current = null;
  };

  return <main
    className={`desktop-companion appearance-${config.appearance} state-${state} motion-${config.motion}`}
    style={{ '--companion-opacity': config.opacity, '--character-height': `${config.characterHeight}px` } as React.CSSProperties}
    aria-label={`桌面小E，${stateCopy[state]}`}
    onPointerDown={beginDrag}
    onPointerMove={continueDrag}
    onPointerUp={endDrag}
    onPointerCancel={endDrag}
    onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } beginListening(); }}
    onDoubleClick={openMain}
    onContextMenu={(event) => { event.preventDefault(); void window.aiSecretary?.companion.showContextMenu(); }}
  >
    <div className="companion-aura" aria-hidden="true"><i /><i /><i /></div>
    {statusText ? <aside className="companion-speech-status" role="status">{statusText}</aside> : null}
    {config.appearance === 'icon' ? <section className="companion-icon" title={`${stateCopy[state]} · 拖动可移动，双击打开聊天`}>
      <img src={xiaoEAvatar} alt="" draggable={false} />
      <span className="companion-state-dot" aria-hidden="true" />
      <span className="visually-hidden" role="status">{stateCopy[state]}{config.mockMode ? '，设备模拟' : ''}</span>
    </section> : <section className="companion-character" title={`${stateCopy[state]} · 拖动可移动，双击打开聊天`}>
      <span className="companion-character-halo" aria-hidden="true" />
      <img src={xiaoEDesktop} alt="" draggable={false} />
      <span className="companion-state-dot" aria-hidden="true" />
      <span className="visually-hidden" role="status">{stateCopy[state]}{config.mockMode ? '，设备模拟' : ''}</span>
    </section>}
  </main>;
}
