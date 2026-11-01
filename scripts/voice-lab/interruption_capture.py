"""Ephemeral, bounded AEC-clean speech candidates; never owns an Agent turn."""
from collections import deque


class InterruptionCapture:
    def __init__(self, emit, sink):
        self.emit, self.sink = emit, sink
        self.serial = 0
        self.key = None
        self.frames = deque(maxlen=160)
        self.pre = deque(maxlen=20)
        self.voiced_since = None
        self.started = self.last_voice = 0
        self.cooldown = 0
        self.ended = False

    def event(self, kind, **fields):
        if self.key:
            g, t, p = self.key
            self.emit(dict(type=kind, generation=g, turn=t, pauseId=p, **fields))

    def clear(self, reason='retired', now=0, notify=True):
        if self.key and notify:
            self.event('interruption-cancelled', reason=reason)
        self.key = None
        self.frames.clear()
        self.pre.clear()
        self.voiced_since = None
        self.ended = False
        self.cooldown = now + .5

    def take(self, generation, turn, pause_id, now):
        self.tick(now)
        if self.key != (generation, turn, pause_id):
            return None
        frames = list(self.frames)
        self.clear('resolved', now, notify=False)
        return frames

    def tick(self, now):
        if self.key and now - self.started >= 1.2:
            self.clear('timeout', now)

    def feed(self, generation, turn, pcm, now, voiced):
        self.tick(now)
        if now < self.cooldown:
            return
        if self.key:
            if self.ended:
                self.frames.append((now, pcm))  # Preserve tail for handoff, never append after ASR commit.
                return
            if len(self.frames) >= 160:
                self.clear('overflow', now)
                return
            self.frames.append((now, pcm))
            self.sink(*self.key, len(self.frames)-1, pcm, now)
            if voiced:
                self.last_voice = now
            if now - self.last_voice >= .2 or now - self.started >= .9:
                self.ended = True
                self.event('interruption-end', frameCount=len(self.frames))
            return
        self.pre.append((now, pcm))
        if not voiced:
            self.voiced_since = None
            return
        if self.voiced_since is None:
            self.voiced_since = now
        if now - self.voiced_since < .12 - 1e-6:
            return
        self.serial += 1
        self.key = generation, turn, self.serial
        self.started = self.last_voice = now
        self.frames.extend(self.pre)
        self.pre.clear()
        self.event('interruption-start')
        for sequence, (at, frame) in enumerate(self.frames):
            self.sink(*self.key, sequence, frame, at)
