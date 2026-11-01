"""Require recent speech and quiet output before accepting an acoustic wake."""
from collections import deque


class WakeGate:
    def __init__(self, min_voiced_frames=8, window_frames=120, playback_cooldown=.8):
        self.min_voiced_frames = min_voiced_frames
        self.voiced = deque(maxlen=window_frames)
        self.playback_cooldown = playback_cooldown
        self.last_playback = None

    def update(self, now, voiced, rendered, standby):
        if rendered:
            self.last_playback = now
        if not standby or rendered:
            self.voiced.clear()
            return False
        if self.last_playback is not None and now - self.last_playback < self.playback_cooldown:
            self.voiced.clear()
            return False
        self.voiced.append(bool(voiced))
        return sum(self.voiced) >= self.min_voiced_frames

    def clear(self):
        self.voiced.clear()
        self.last_playback = None
