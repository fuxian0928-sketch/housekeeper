const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { NativeAudioChannel } = require('./native-audio-channel.cjs');
const {setTimeout:delay}=require('node:timers/promises');

// Trusted main-process use only. Do not expose executable/args to renderer IPC.
// No listening TCP port; commands use inherited stdio. Not enabled by default.
class VoiceWorkerSupervisor extends EventEmitter {
  constructor({ executable, args, cwd, startupMs = 15000, heartbeatMs = 1000, silenceMs = 4000, stopMs = 1500, audioConsumer, interruptionConsumer }) {
    super();
    this.options = { executable, args, cwd, startupMs, heartbeatMs, silenceMs, stopMs, audioConsumer, interruptionConsumer };
    this.current = null;
    this.generation = 0;
  }

  start() {
    if (this.current) return Promise.reject(new Error('Voice worker already running'));
    const o = this.options;
    const child = spawn(o.executable, o.args, { cwd: o.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const run = { child, generation: ++this.generation, ready: false, stopping: false, buffer: '', lastSeen: performance.now(), timers: [] };
    this.current = run;
    const audio = o.audioConsumer ? new NativeAudioChannel(o.audioConsumer) : null;
    const candidateAudio = o.interruptionConsumer ? new NativeAudioChannel(o.interruptionConsumer) : null;
    let clockSequence = 0;
    const ping = () => {
      if (child.stdin.destroyed || child.stdin.writableLength >= 1024) return;
      const token = String(++clockSequence);
      audio?.ping(token); candidateAudio?.ping(token);
      child.stdin.write(JSON.stringify({type:'ping',token})+'\n');
    };
    run.closed = new Promise(resolve => { run.resolveClosed = resolve; });
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = code => {
        if (!settled) { settled = true; reject(new Error(code)); }
        if (!run.stopping) { run.stopping = true; this.emit('fault', { code, generation: run.generation }); }
        child.kill();
      };
      const emit = message => {
        if (this.current !== run || run.stopping) return;
        if (message?.type === 'audio' || message?.type === 'interruption-audio') {
          const channel = message.type === 'audio' ? audio : candidateAudio;
          if (message.type === 'interruption-audio' && (!Number.isSafeInteger(message.pauseId) || message.pauseId < 1)) { fail('INVALID_AUDIO_PACKET'); return; }
          if (!run.ready || !channel) { fail('UNEXPECTED_AUDIO_PACKET'); return; }
          try { channel.receive(message, run.generation); } catch (error) { fail(['AUDIO_CLOCK_UNAVAILABLE','INVALID_AUDIO_PACKET','AUDIO_PACKET_EXPIRED','AUDIO_CONSUMER_REJECTED'].includes(error.message) ? error.message : 'AUDIO_CONSUMER_FAILED'); }
          return;
        }
        if (!message || !['ready', 'alive', 'wake', 'stopped', 'turn-start', 'turn-end', 'turn-cancelled', 'standby', 'playback-submitted', 'playback-progress', 'playback-failed', 'listening', 'idle-farewell', 'voice-preview', 'playback-paused', 'playback-resumed', 'interruption-start', 'interruption-end', 'interruption-cancelled'].includes(message.type)) { fail('INVALID_WORKER_EVENT'); return; }
        if (message.type === 'ready') {
          if (run.ready) { fail('DUPLICATE_READY'); return; }
          run.ready = true;
          run.lastSeen = performance.now();
          clearTimeout(run.startup);
          if (!settled) { settled = true; resolve({ generation: run.generation }); }
          ping();
          run.timers.push(setInterval(() => {
            if (run.stopping) return;
            if (performance.now() - run.lastSeen > o.silenceMs) { fail('WORKER_HEARTBEAT_TIMEOUT'); return; }
            ping();
          }, o.heartbeatMs));
        }
        if (message.type === 'alive') { run.lastSeen = performance.now(); audio?.synchronize(message.token, message.workerClockMs); candidateAudio?.synchronize(message.token, message.workerClockMs); }
        if (message.type === 'stopped') {
          run.completed = true;
          if (message.failure) { fail(message.failure === 'AudioCaptureStalled' ? 'AUDIO_CAPTURE_STALLED' : 'WORKER_RUNTIME_FAILED'); return; }
        }
        // Only allowlisted metadata escapes. No raw PCM/transcript/provider error forwarding.
        if (message.type === 'wake' && !run.ready) { fail('WAKE_BEFORE_READY'); return; }
        const event = { type: message.type, generation: run.generation };
        if (['turn-start','turn-end','turn-cancelled','standby','playback-submitted', 'playback-progress','playback-failed','listening','idle-farewell', 'voice-preview', 'playback-paused', 'playback-resumed', 'interruption-start', 'interruption-end', 'interruption-cancelled'].includes(message.type)) {
          if (!run.ready || !Number.isSafeInteger(message.turn) || message.turn < 0 || !Number.isSafeInteger(message.generation) || message.generation < 1) { fail('INVALID_TURN_EVENT'); return; }
          Object.assign(event, { turn: message.turn, audioGeneration: message.generation });
          if (message.type.startsWith('interruption-')) {
            if (!Number.isSafeInteger(message.pauseId) || message.pauseId < 1) { fail('INVALID_PAUSE_EVENT'); return; }
            event.pauseId = message.pauseId;
            if (message.type === 'interruption-start' && ['processing','speaking'].includes(message.phase)) event.phase = message.phase;
            if (message.type === 'interruption-end') {
              if (!Number.isSafeInteger(message.frameCount) || message.frameCount < 1 || message.frameCount > 160) { fail('INVALID_AUDIO_PACKET'); return; }
              event.frameCount = message.frameCount;
            }
          }
          if (message.type === 'playback-paused' || message.type === 'playback-resumed') {
            if (!Number.isSafeInteger(message.pauseId) || message.pauseId < 1 || !Number.isSafeInteger(message.renderedFrames) || message.renderedFrames < 0 || message.renderedFrames > 30000) { fail('INVALID_PAUSE_EVENT'); return; }
            Object.assign(event, { pauseId: message.pauseId, renderedFrames: message.renderedFrames });
          }
          if (['playback-submitted','playback-progress'].includes(message.type)) {
            if (!Number.isSafeInteger(message.renderedFrames) || message.renderedFrames < 1 || message.renderedFrames > 30000) { fail('INVALID_PLAYBACK_EVENT'); return; }
            event.renderedFrames = message.renderedFrames;
            if(message.health!==undefined){
              const fields=['startupFrames','pausedFrames','underrunFrames','underrunCount','queuedFrames'];
              if(!message.health||!fields.every(name=>Number.isSafeInteger(message.health[name])&&message.health[name]>=0&&message.health[name]<=(name==='queuedFrames'?200:24000))){fail('INVALID_PLAYBACK_EVENT');return;}
              event.health=Object.fromEntries(fields.map(name=>[name,message.health[name]]));
              for(const name of ['deviceOutputUnderflows','deviceInputOverflows','deviceLateCallbacks','deviceMaxGapMs','headOutputUnderflows','headLateCallbacks','headMaxGapMs']){
                if(message.health[name]===undefined)continue; // Older device workers remain compatible.
                if(!Number.isSafeInteger(message.health[name])||message.health[name]<0||message.health[name]>240000){fail('INVALID_PLAYBACK_EVENT');return;}
                event.health[name]=message.health[name];
              }
            }
          }
          if (message.type === 'playback-failed') event.code = 'PLAYBACK_PACKET_REJECTED';
          if (message.type === 'turn-end' && Number.isSafeInteger(message.frameCount) && message.frameCount >= 0) event.frameCount = message.frameCount;
          if (['wake','speech','interruption','interrupted','max-duration','silence','idle','dismissed','work-timeout','discontinuity','stopped','manual-wake','short-noise'].includes(message.reason)) event.reason = message.reason;
        }
        this.emit('event', event);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        if (run.stopping) return;
        run.buffer += data;
        let newline;
        while ((newline = run.buffer.indexOf('\n')) >= 0) {
          if (newline > 16384) { fail('WORKER_OUTPUT_OVERFLOW'); return; }
          const line = run.buffer.slice(0, newline);
          run.buffer = run.buffer.slice(newline + 1);
          try { emit(JSON.parse(line)); } catch { fail('INVALID_WORKER_JSON'); return; }
          if (run.stopping) return;
        }
        if (Buffer.byteLength(run.buffer) > 16384) fail('WORKER_OUTPUT_OVERFLOW');
      });
      // Drain native diagnostic output without exposing device paths or unbounded storage.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => { if (!run.stopping) fail('WORKER_PIPE_ERROR'); });
      child.on('error', () => fail('WORKER_SPAWN_FAILED'));
      child.on('close', (code, signal) => {
        clearTimeout(run.startup);
        run.timers.forEach(clearInterval);
        if (!settled) { settled = true; reject(new Error(run.stopping ? 'WORKER_STOPPED' : 'WORKER_EXITED_BEFORE_READY')); }
        if (this.current === run) this.current = null;
        if (run.ready && !run.stopping && !run.completed) this.emit('fault', { code: 'WORKER_UNEXPECTED_EXIT', generation: run.generation });
        run.resolveClosed();
        this.emit('closed', { generation: run.generation, code, signal });
      });
      run.startup = setTimeout(() => fail('WORKER_START_TIMEOUT'), o.startupMs);
    });
  }

  async stop() {
    const run = this.current;
    if (!run) return;
    run.stopping = true;
    clearTimeout(run.startup);
    run.timers.forEach(clearInterval);
    if (!run.child.stdin.destroyed) run.child.stdin.end('{"type":"stop"}\n');
    const force = setTimeout(() => run.child.kill(), this.options.stopMs);
    try { await run.closed; } finally { clearTimeout(force); }
  }

  configureTiming({ voiceContinuousEnabled = true, voiceMinSpeechMs = 120, voiceMaxUtteranceSeconds = 30, voiceIdleSeconds, voiceEndSilenceMs, voiceBargeInEnabled = true }) {
    const run = this.current;
    if (!run || !run.ready || run.stopping) return false;
    if (!Number.isInteger(voiceMinSpeechMs) || voiceMinSpeechMs < 50 || voiceMinSpeechMs > 500) return false;
    if (typeof voiceContinuousEnabled !== 'boolean' || typeof voiceBargeInEnabled !== 'boolean' || !Number.isInteger(voiceMaxUtteranceSeconds) || voiceMaxUtteranceSeconds < 5 || voiceMaxUtteranceSeconds > 30) return false;
    if (!Number.isInteger(voiceIdleSeconds) || voiceIdleSeconds < 30 || voiceIdleSeconds > 1800 || !Number.isInteger(voiceEndSilenceMs) || voiceEndSilenceMs < 300 || voiceEndSilenceMs > 3000) return false;
    if (run.child.stdin.destroyed || run.child.stdin.writableLength > 32_000) return false;
    // Trusted desktop policy, never taken from renderer settings. The TS turn
    // owner tracks real response/device progress instead of cutting audio at 30s.
    run.child.stdin.write(JSON.stringify({ type: 'configure-timing', ownerManaged: true, continuousEnabled: voiceContinuousEnabled, minSpeechMs: voiceMinSpeechMs, maxUtteranceSeconds: voiceMaxUtteranceSeconds, idleSeconds: voiceIdleSeconds, endSilenceMs: voiceEndSilenceMs, bargeInEnabled: voiceBargeInEnabled }) + '\n');
    return true;
  }

  configureWake(enabled) {
    const run = this.current;
    if (!run || !run.ready || run.stopping || typeof enabled !== 'boolean') return false;
    if (run.child.stdin.destroyed || run.child.stdin.writableLength > 32_000) return false;
    run.child.stdin.write(JSON.stringify({ type: 'configure-wake', enabled }) + '\n');
    return true;
  }

  sessionControl(type) {
    const run = this.current;
    if (!run || !run.ready || run.stopping || !['manual-wake', 'manual-dismiss', 'voice-preview'].includes(type)) return false;
    if (run.child.stdin.destroyed || run.child.stdin.writableLength > 32_000) return false;
    // Inherited pipe belongs only to this process. Never queue across worker restarts.
    run.child.stdin.write(JSON.stringify({ type }) + '\n');
    return true;
  }

  command({ generation, audioGeneration, turn, type }) {
    const run = this.current;
    if (!run || !run.ready || run.stopping || generation !== run.generation) return false;
    if (!['answer-finished','answer-failed','speaking','dismiss','dismiss-after-playback'].includes(type) || !Number.isSafeInteger(audioGeneration) || audioGeneration < 1 || !Number.isSafeInteger(turn) || turn < 1) return false;
    if (run.child.stdin.destroyed || run.child.stdin.writableLength > 32_000) return false;
    run.child.stdin.write(JSON.stringify({type,generation:audioGeneration,turn})+'\n');
    return true;
  }

  resolveInterruption({ workerGeneration, audioGeneration, turn, pauseId }, decision) {
    const run = this.current;
    if (!run || !run.ready || run.stopping || workerGeneration !== run.generation) return false;
    if (![audioGeneration, turn, pauseId].every(n => Number.isSafeInteger(n) && n > 0) || !['resume','interrupt','stop'].includes(decision)) return false;
    if (run.child.stdin.destroyed || run.child.stdin.writableLength > 32_000) return false;
    run.child.stdin.write(JSON.stringify({ type: 'interruption-resolve', generation: audioGeneration, turn, pauseId, decision })+'\n');
    return true;
  }

  async waitForPlaybackCapacity({generation},signal) {
    signal.throwIfAborted();const run=this.current;
    while(run&&this.current===run&&run.ready&&!run.stopping&&generation===run.generation&&!run.child.stdin.destroyed){
      if(run.child.stdin.writableLength<=8000)return true;
      await delay(5,undefined,{signal});
    }
    return false;
  }

  playback({ generation, audioGeneration, turn, type, sequence, pcm, pauseId }) {
    const run = this.current;
    if (!run || !run.ready || run.stopping || generation !== run.generation) return false;
    if (!Number.isSafeInteger(audioGeneration) || audioGeneration < 1 || !Number.isSafeInteger(turn) || turn < 1) return false;
    if (!['playback-begin','playback-audio','playback-end','playback-cancel','playback-pause','playback-resume'].includes(type)) return false;
    const packet = { type, generation: audioGeneration, turn };
    if (type === 'playback-pause' || type === 'playback-resume') {
      if (!Number.isSafeInteger(pauseId) || pauseId < 1) return false;
      packet.pauseId = pauseId;
    }
    if (['playback-audio','playback-end'].includes(type)) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) return false;
      packet.sequence = sequence;
    }
    if (type === 'playback-audio') {
      if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length > 6400 || pcm.length % 320) return false;
      packet.pcm = pcm.toString('base64');
    }
    // Reserve room for cancellation and pause commands even while PCM drains.
    if (run.child.stdin.destroyed || run.child.stdin.writableLength > (type==='playback-audio'?16_000:32_000)) return false;
    run.child.stdin.write(JSON.stringify(packet)+'\n');
    return true;
  }
}

module.exports = { VoiceWorkerSupervisor };
