"""Bounded PCM16 output owned by one generation/turn; never stores recordings."""
from collections import deque
import math
import threading
import time
import numpy as np


class PlaybackBuffer:
    def __init__(self, capacity_frames=200):
        self.capacity = capacity_frames
        self.lock = threading.Lock()
        self.frames = deque()
        self.key = None
        self.high_water = (0, 0)
        self.sequence = 0
        self.ended = False
        self.rendered = 0
        self.completed = None
        self.pause_id = 0
        self.pause_deadline = None
        self.pause_event = None
        self.progress = None
        self.reported = 0
        self.started = False
        self._reset_health()

    def _reset_health(self):
        self.startup_frames = self.paused_frames = self.underrun_frames = self.underrun_count = 0
        self.in_gap = self.rebuffering = False
        self.last_callback_at = None
        self.device_health = dict.fromkeys(('deviceOutputUnderflows', 'deviceInputOverflows',
            'deviceLateCallbacks', 'deviceMaxGapMs', 'headOutputUnderflows',
            'headLateCallbacks', 'headMaxGapMs'), 0)

    def health(self):
        with self.lock:
            return {'startupFrames': self.startup_frames, 'pausedFrames': self.paused_frames,
                    'underrunFrames': self.underrun_frames, 'underrunCount': self.underrun_count,
                    'queuedFrames': len(self.frames), **self.device_health}

    def _underrun(self):
        self.underrun_frames += 1
        if not self.in_gap: self.underrun_count += 1
        self.in_gap = True
        self.rebuffering = True

    def start(self, generation, turn):
        key = (generation, turn)
        if any(type(value) is not int or value < 1 for value in key):
            return False
        with self.lock:
            if key <= self.high_water:
                return False
            self.high_water = key
            self.key = key
            self.frames.clear()
            self.sequence = self.rendered = 0
            self.ended = False
            self.completed = None
            self.pause_id = 0
            self.pause_deadline = None
            self.pause_event = None
            self.progress = None
            self.reported = 0
            self.started = False
            self._reset_health()
            return True

    def append(self, generation, turn, sequence, pcm):
        with self.lock:
            if self.key != (generation, turn) or self.ended:
                return False
            if type(sequence) is not int or sequence != self.sequence or not isinstance(pcm, bytes) or not pcm or len(pcm) % 320 or len(pcm) > 6400 or len(self.frames) + len(pcm)//320 > self.capacity:
                self._clear()
                return False
            samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
            self.frames.extend(samples[i:i+160] for i in range(0, len(samples), 160))
            self.sequence += 1
            return True

    def end(self, generation, turn, sequence):
        with self.lock:
            if self.key != (generation, turn):
                return False
            if type(sequence) is not int or sequence != self.sequence or sequence == 0 or self.ended:
                self._clear()
                return False
            self.ended = True
            return True

    def pause(self, generation, turn, pause_id, now=None):
        now = time.perf_counter() if now is None else now
        with self.lock:
            if self.key != (generation, turn) or type(pause_id) is not int or pause_id <= self.pause_id or self.pause_deadline is not None or not np.isfinite(now):
                return False
            self.pause_id = pause_id
            self.pause_deadline = now + 1.5
            self.pause_event = ('playback-paused', generation, turn, pause_id, self.rendered)
            return True

    def resume(self, generation, turn, pause_id):
        with self.lock:
            if self.key != (generation, turn) or type(pause_id) is not int or pause_id != self.pause_id or self.pause_deadline is None:
                return False
            self._resume()
            return True

    def _resume(self):
        self.pause_deadline = None
        self.pause_event = ('playback-resumed', *self.key, self.pause_id, self.rendered)

    def take_pause_event(self):
        with self.lock:
            event = self.pause_event
            self.pause_event = None
            return event

    def render(self, now=None, *, output_underflow=False, input_overflow=False):
        # Called once per actual 10ms device callback. The returned samples must
        # feed both output channels AND the AEC reference, without separate copies.
        with self.lock:
            now = time.perf_counter() if now is None else now
            if self.key and self.started and math.isfinite(now):
                # A full PCM queue does not prove the device met its deadline.
                # Keep onset (first 2s of audio) separate from the whole turn.
                head = self.rendered < 200
                gap = max(0, now - self.last_callback_at) if self.last_callback_at is not None else 0
                gap_ms = min(240000, round(gap * 1000))
                values = self.device_health
                values['deviceOutputUnderflows'] += bool(output_underflow)
                values['deviceInputOverflows'] += bool(input_overflow)
                values['deviceLateCallbacks'] += gap > .025
                values['deviceMaxGapMs'] = max(values['deviceMaxGapMs'], gap_ms)
                if head:
                    values['headOutputUnderflows'] += bool(output_underflow)
                    values['headLateCallbacks'] += gap > .025
                    values['headMaxGapMs'] = max(values['headMaxGapMs'], gap_ms)
            if math.isfinite(now): self.last_callback_at = now
            # Only previous callbacks are counted as submitted. Never claim the
            # block currently being returned has already reached the device.
            if self.key and self.rendered > self.reported and (self.reported == 0 or self.rendered//25 > self.reported//25):
                self.reported = self.rendered
                self.progress = (*self.key, self.rendered)
            if self.pause_deadline is not None:
                if np.isfinite(now) and now < self.pause_deadline:
                    self.paused_frames += 1
                    return np.zeros(160, np.float32)
                self._resume()
            # Wait for a small device-side cushion before rendering a stream.
            # Otherwise a 10ms callback can outrun just-in-time IPC packets.
            if not self.started and self.frames and (len(self.frames) >= 10 or self.ended):
                self.started = True
            if self.key and not self.started and not self.ended:
                self.startup_frames += 1
            # Following starvation, collect 200ms once rather than alternating
            # single 10ms syllable fragments and silence. EOS releases short tails.
            if self.started and self.rebuffering and not self.ended and len(self.frames) < 20:
                self._underrun()
                return np.zeros(160, np.float32)
            if self.started and self.frames:
                self.in_gap = self.rebuffering = False
                self.rendered += 1
                return self.frames.popleft()
            if self.key and self.ended:
                # A subsequent callback confirms the final block was submitted;
                # this is device submission, not proof of audible speaker output.
                self.completed = (*self.key, self.rendered)
                self.key = None
            elif self.key and self.started:
                self._underrun()
            return np.zeros(160, np.float32)

    def take_completed(self):
        with self.lock:
            result = self.completed
            self.completed = None
            return result

    def take_progress(self):
        with self.lock:
            result = self.progress
            self.progress = None
            return result

    def _clear(self):
        self.progress = None
        self.pause_deadline = self.pause_event = None
        self.frames.clear()
        self.key = None
        self.completed = None
        self.ended = False
        self.started = False
        self._reset_health()

    def cancel(self):
        with self.lock:
            self._clear()
