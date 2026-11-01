"""P0 integrated native duplex runtime. No cloud calls, disk audio or implicit device selection.

10ms capture and the exact rendered reference share a callback. The inference owner
runs outside the callback. Overrun/discontinuity discards both AEC and KWS history.
"""
from collections import deque
import threading
import time

import numpy as np
import sherpa_onnx
from pywebrtc_audio import VoiceDetector
from audio_pipeline import EchoPipeline
from worker import WakeSession
from turn_segmenter import TurnSegmenter
from wake_gate import WakeGate


class DuplexQueue:
    def __init__(self, clock=time.perf_counter, capacity=15, max_age=.15):
        if capacity < 1 or max_age <= 0:
            raise ValueError('Invalid queue budget')
        self.clock = clock
        self.capacity = capacity
        self.max_age = max_age
        self.lock = threading.Lock()
        self.frames = deque()
        self.epoch = 0
        self.dropped = 0
        self.last_capture = None

    def push(self, captured_at, near, far, device_fault=False):
        for frame in (near, far):
            if frame.dtype != np.float32 or frame.shape != (160,):
                raise ValueError('Expected a 10ms mono frame at 16kHz')
        now = self.clock()
        if not np.isfinite(captured_at) or captured_at > now + .01:
            raise ValueError('Invalid capture timestamp')
        with self.lock:
            if self.last_capture is not None and captured_at < self.last_capture:
                self.dropped += 1
                return
            gap = self.last_capture is not None and captured_at-self.last_capture > self.max_age
            self.last_capture = captured_at
            if device_fault or gap or len(self.frames) >= self.capacity:
                self.dropped += len(self.frames)
                self.frames.clear()
                self.epoch += 1
            if now - captured_at > self.max_age:
                self.dropped += 1
                self.epoch += 1
                self.frames.clear()
                return
            self.frames.append((self.epoch, captured_at, near.copy(), far.copy()))

    def pop(self):
        with self.lock:
            if self.frames and self.clock() - self.frames[0][1] > self.max_age:
                # Never feed AEC/KWS non-contiguous fragments as a continuous utterance.
                self.dropped += len(self.frames)
                self.frames.clear()
                self.epoch += 1
                self.last_capture = None
            return self.frames.popleft() if self.frames else None

    def clear(self):
        with self.lock:
            self.frames.clear()
            self.last_capture = None
            self.epoch += 1


class DuplexEngine:
    def __init__(self, model, keywords, emit, delay_ms=44, audio_sink=None, timing=None, interruption_sink=None, noise_suppression=False, auto_gain=False):
        suffix = 'epoch-13-avg-2-chunk-8-left-64'
        self.kws = sherpa_onnx.KeywordSpotter(tokens=str(model / 'tokens.txt'), encoder=str(model / f'encoder-{suffix}.int8.onnx'), decoder=str(model / f'decoder-{suffix}.onnx'), joiner=str(model / f'joiner-{suffix}.int8.onnx'), keywords_file=str(keywords), num_threads=2, provider='cpu')
        self.emit = emit
        self.delay_ms = delay_ms
        self.noise_suppression = noise_suppression
        self.auto_gain = auto_gain
        self.wake_enabled = True
        self.epoch = -1
        self.frames = 0
        self.resets = 0
        self.closed = False
        self.session = WakeSession()
        self.aec = None
        self.stream = None
        self.vad = None
        self.delivered_audio_bytes = 0
        self.wake_gate = WakeGate()
        def deliver(generation, turn, pcm, captured_at):
            self.delivered_audio_bytes += len(pcm)
            if audio_sink is not None:
                audio_sink(generation,turn,pcm,captured_at)
        self.segmenter = TurnSegmenter(emit,deliver,timing,interruption_sink=interruption_sink)

    def process(self, item):
        if self.closed or item[0] < self.epoch:
            return
        epoch, captured_at, near, far = item
        if epoch != self.epoch:
            self.epoch = epoch
            self.resets += 1
            self.aec = EchoPipeline(delay_ms=self.delay_ms, noise_suppression=self.noise_suppression, auto_gain=self.auto_gain)
            self.stream = self.kws.create_stream()
            self.session.reset(self.session.generation + 1)
            self.segmenter.reset(self.session.generation)
            self.vad = VoiceDetector(sample_rate=16000)
            self.wake_gate.clear()
        clean = self.aec.process(near, far)
        self.frames += 1
        pcm = (np.clip(clean, -1, 1) * 32767).astype('<i2').tobytes()
        self.session.accept(self.session.generation, self.frames, pcm)
        voiced = float(np.sqrt(np.mean(clean**2)))>.008 and self.vad.process(clean)>.6
        rendered = float(np.max(np.abs(far))) > .001
        self.segmenter.feed(pcm,captured_at,voiced,rendered=rendered)
        wake_ready = self.wake_gate.update(captured_at, voiced, rendered, self.segmenter.state == 'standby')
        # The farewell is still our own output. Wait for it to finish before
        # accepting a new acoustic wake, even when dismissal is pending.
        if self.segmenter.state != 'standby':
            return
        if not self.wake_enabled:
            return
        if rendered or (self.wake_gate.last_playback is not None and captured_at - self.wake_gate.last_playback < self.wake_gate.playback_cooldown):
            self.kws.reset_stream(self.stream)
            return
        if self.session.active:
            self.session.active=False
            self.kws.reset_stream(self.stream)
        self.stream.accept_waveform(16000, clean)
        while self.kws.is_ready(self.stream):
            self.kws.decode_stream(self.stream)
            if self.kws.get_result(self.stream):
                if not wake_ready:
                    self.kws.reset_stream(self.stream)
                    continue
                if not self.session.trigger():
                    break
                if self.segmenter.wake(captured_at):
                    self.emit({'type': 'wake', 'generation': self.session.generation, 'frame': self.frames, 'captureAgeMs': round((time.perf_counter()-captured_at)*1000,2)})
                self.kws.reset_stream(self.stream)
                break

    def close(self):
        self.closed = True
        self.session.ring.clear()
        self.aec = None
        self.stream = None
        self.kws = None
        self.vad = None
        self.wake_gate.clear()
        self.segmenter.reset(self.session.generation+1,reason='stopped')
