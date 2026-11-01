"""Prototype native audio processing. One owner thread; 10ms frames only."""
from collections import deque
import math
import time

import numpy as np
from pywebrtc_audio import AudioProcessor


class FreshFrameQueue:
    """Bound memory and age independently. Never replay delayed microphone audio."""
    def __init__(self, max_frames=15, max_age=.15, clock=time.perf_counter):
        if max_frames < 1 or max_age <= 0:
            raise ValueError('Invalid queue budget')
        self.frames = deque(maxlen=max_frames)
        self.max_age = max_age
        self.clock = clock
        self.dropped = 0

    def push(self, pcm, captured_at):
        if pcm.dtype != np.float32 or pcm.ndim != 1 or not 1 <= len(pcm) <= 480:
            raise ValueError('Capture queue requires at most 10ms mono 48kHz float32')
        if not math.isfinite(captured_at) or captured_at > self.clock() + .01:
            raise ValueError('Invalid capture timestamp')
        if self.clock() - captured_at > self.max_age:
            self.dropped += 1
            return
        if len(self.frames) == self.frames.maxlen:
            self.dropped += 1
        self.frames.append((captured_at, pcm.copy()))

    def pop(self):
        now = self.clock()
        while self.frames:
            timestamp, pcm = self.frames.popleft()
            if now - timestamp <= self.max_age:
                return timestamp, pcm
            self.dropped += 1
        return None

    def clear(self):
        self.frames.clear()


class EchoPipeline:
    def __init__(self, rate=16000, delay_ms=0, noise_suppression=False, auto_gain=False):
        if type(delay_ms) is not int or not 0 <= delay_ms <= 250 or type(noise_suppression) is not bool or type(auto_gain) is not bool:
            raise ValueError('Invalid audio processing configuration')
        if rate not in (16000, 32000, 48000):
            raise ValueError('Use a supported native processing rate')
        self.rate = rate
        self.frame_size = rate // 100
        self.processor = AudioProcessor(sample_rate=rate, num_channels=1,
                                        echo_cancellation=True, noise_suppression=noise_suppression,
                                        auto_gain_control=auto_gain, stream_delay_ms=delay_ms)

    def process(self, microphone, render_reference):
        for frame in (microphone, render_reference):
            if frame.dtype != np.float32 or frame.ndim != 1 or len(frame) != self.frame_size:
                raise ValueError('Expected exact 10ms mono float32 frame')
            if not np.isfinite(frame).all() or np.max(np.abs(frame)) > 1:
                raise ValueError('PCM out of range')
        # The reference is the signal sent to the output device, not generated text/audio still queued.
        return self.processor.process(microphone, render_reference)
