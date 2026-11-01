"""Bounded sentence edge treatment. No respeeding or cross-sentence codec state."""
import numpy as np


class SpeechPcmEdges:
    def __init__(self, sample_rate=16000, target_pause_ms=80):
        if type(target_pause_ms) is not int or not 0 <= target_pause_ms <= 400:
            raise ValueError('Invalid speech pause')
        self.fade = sample_rate // 200  # 5ms, at sentence boundaries only.
        self.keep_silence = sample_rate * target_pause_ms // 1000
        self.pad_pause = target_pause_ms != 80
        self.capacity = sample_rate // 2
        self.pending = np.empty(0, dtype=np.float32)
        self.started = False
        self.trimmed_samples = 0

    def _emit(self, audio):
        if len(audio) and not self.started:
            audio = audio.copy()
            size = min(len(audio), self.fade)
            audio[:size] *= np.linspace(0, 1, size, dtype=np.float32)
            self.started = True
        return audio

    def push(self, samples):
        self.pending = np.concatenate((self.pending, np.asarray(samples, dtype=np.float32)))
        active = np.flatnonzero(np.abs(self.pending) > 0.00025)
        last = int(active[-1]) + 1 if len(active) else 0
        cut = max(0, len(self.pending) - self.capacity, last - self.fade)
        output, self.pending = self.pending[:cut], self.pending[cut:].copy()
        return self._emit(output)

    def finish(self):
        active = np.flatnonzero(np.abs(self.pending) > 0.00025)
        last = int(active[-1]) + 1 if len(active) else 0
        end = min(len(self.pending), last + self.keep_silence)
        self.trimmed_samples = len(self.pending) - end
        audio = self.pending[:end].copy()
        size = min(last, self.fade)
        if size: audio[last-size:last] *= np.linspace(1, 0, size, dtype=np.float32)
        if self.pad_pause and last and len(audio)-last < self.keep_silence:
            audio = np.concatenate((audio, np.zeros(self.keep_silence-(len(audio)-last), dtype=np.float32)))
        self.pending = np.empty(0, dtype=np.float32)
        return self._emit(audio)


def sentence_pause_ms(text):
    # The model owns semantic phrasing. PCM adds only bounded, intentional
    # breathing room at segment boundaries, never stretches phonemes.
    end=text.rstrip().rstrip('”’」』）)]')
    if end.endswith(('。','！','？','.','!','?','；',';')): return 220
    if end.endswith(('，',',','：',':','、')): return 120
    return 80


def split_oversized_text(text):
    # The shared response planner already sends <=160 character segments. Only
    # direct long-text calls need this fallback; never hard-cut them every 100.
    while len(text) > 160:
        candidates = [i+1 for i, char in enumerate(text[:101]) if char in '。！？；，、\n ' and i >= 23]
        cut = candidates[-1] if candidates else 100
        if text[cut-1].isascii() and text[cut-1].isalnum() and text[cut].isascii() and text[cut].isalnum():
            start = cut
            while start and text[start-1].isascii() and (text[start-1].isalnum() or text[start-1] in '._-:/%'): start -= 1
            if start >= 24: cut = start
        yield text[:cut]
        text = text[cut:]
    if text.strip(): yield text
