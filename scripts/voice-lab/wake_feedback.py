"""Local wake cue: one expiring clip, rendered through the existing device/AEC path."""
import math
import threading
import numpy as np


class WakeFeedback:
    def __init__(self):
        self.lock = threading.Lock()
        # 120 ms with smooth edges; precompute outside the realtime callback.
        t = np.arange(1920) / 16000
        envelope = np.minimum(1, np.minimum(t / .01, (.12 - t) / .01))
        self.samples = (.12 * np.sin(2 * np.pi * 880 * t) * envelope).astype(np.float32)
        self.position = len(self.samples)
        self.generation = 0
        self.triggered_at = None
        self.first_frame_ms = None
        self.trigger_count = self.expired_count = self.submitted_frames = 0

    def trigger(self, generation, now):
        if type(generation) is not int or generation < 1 or not math.isfinite(now):
            return False
        with self.lock:
            if generation < self.generation:
                return False
            if self.triggered_at is not None and now - self.triggered_at < .5:
                return False
            self.generation = generation
            self.triggered_at = now
            self.position = 0
            self.first_frame_ms = None
            self.trigger_count += 1
            return True

    def cancel(self):
        with self.lock:
            self.position = len(self.samples)

    def render(self, generation, now):
        with self.lock:
            if self.position >= len(self.samples):
                return np.zeros(160, np.float32)
            age = now - self.triggered_at
            if generation != self.generation or not math.isfinite(age) or age < 0 or age > .4:
                self.position = len(self.samples)
                self.expired_count += 1
                return np.zeros(160, np.float32)
            if self.position == 0:
                self.first_frame_ms = age * 1000
            frame = self.samples[self.position:self.position+160].copy()
            self.position += 160
            self.submitted_frames += 1
            return frame

    def report(self):
        with self.lock:
            return {'triggers': self.trigger_count, 'submittedFrames': self.submitted_frames,
                    'lastFirstFrameMs': self.first_frame_ms, 'expiredClips': self.expired_count,
                    'durationMs': 120, 'audibilityVerified': False}
