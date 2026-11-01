"""Single-owner voice turn segmentation. PCM stays in memory or trusted sink only."""
from collections import deque
from dataclasses import dataclass
import math
from interruption_capture import InterruptionCapture


@dataclass(frozen=True)
class TurnTiming:
    idle_seconds: float = 300
    end_silence: float = 1
    min_voice: float = .12
    max_utterance: float = 30
    work_timeout: float = 30
    # The desktop owner has separate capture, inactivity and hard deadlines.
    # Standalone lab runs retain their local watchdog; the controlled process
    # also exits on parent heartbeat loss/EOF, even with this flag enabled.
    owner_managed: bool = False
    continuous: bool = True
    barge_in: bool = True

    def __post_init__(self):
        if type(self.owner_managed) is not bool:
            raise ValueError("Invalid owner_managed")
        if type(self.continuous) is not bool:
            raise ValueError("Invalid continuous")
        if type(self.barge_in) is not bool:
            raise ValueError("Invalid barge_in")
        for name, lower, upper in [('idle_seconds',30,1800),('end_silence',.3,3),('min_voice',.05,.5),('max_utterance',5,30),('work_timeout',5,120)]:
            value=getattr(self,name)
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not lower<=value<=upper:
                raise ValueError(f'Invalid {name}')


class TurnSegmenter:
    def __init__(self, emit, audio_sink, timing=None, interruption_sink=None):
        self.emit=emit
        self.audio_sink=audio_sink
        self.timing=timing or TurnTiming()
        self.next_timing=self.timing
        self.barge_in_enabled=self.timing.barge_in
        self.generation=0
        self.turn=0
        self.state='standby'
        self.dismiss_pending=False
        self.recovery_since=None
        self.answer_completed=False
        self.pre_roll=deque(maxlen=150)
        self.candidate=None
        self.last_voice=None
        self.started=None
        self.waiting_since=None
        self.last_frame=None
        self.capture_reason=None
        self.voiced_duration=0
        self.last_voice_before_capture=None
        self.interruption = InterruptionCapture(lambda event: emit({**event, **({'phase': self.state} if event['type']=='interruption-start' else {})}), interruption_sink) if interruption_sink else None

    def event(self, kind, **fields):
        self.emit({'type':kind,'generation':self.generation,'turn':self.turn,**fields})

    def reset(self, generation, reason='discontinuity'):
        if type(generation) is not int or generation<=self.generation:
            return False
        if self.interruption:
            self.interruption.clear()
        if self.state in ('capturing','processing','speaking'):
            self.event('turn-cancelled',reason=reason)
        self.generation=generation
        self.state='standby'
        self.dismiss_pending=False
        self.recovery_since=None
        self.answer_completed=False
        self.pre_roll.clear()
        self.candidate=self.last_voice=self.started=self.waiting_since=self.last_frame=None
        self.capture_reason=None
        self.voiced_duration=0
        self.last_voice_before_capture=None
        return True

    def configure(self, timing):
        if not isinstance(timing, TurnTiming):
            raise ValueError('Expected validated timing')
        self.next_timing=timing
        self.barge_in_enabled=timing.barge_in
        if not self.barge_in_enabled and self.interruption:
            self.interruption.clear()

    def begin(self, now, reason, previous_voice=None):
        self.dismiss_pending=False
        self.recovery_since=None
        self.answer_completed=False
        self.turn+=1
        self.started=now
        self.capture_reason=reason
        self.voiced_duration=max(0, now-self.candidate)+.01 if reason=='speech' and self.candidate is not None else 0
        self.last_voice_before_capture=previous_voice
        self.state='capturing'
        self.event('turn-start',reason=reason)
        for captured_at, pcm in self.pre_roll:
            self.audio_sink(self.generation,self.turn,pcm,captured_at)
        self.pre_roll.clear()

    def wake(self, now):
        if self.state!='standby' or self.generation==0:
            return False
        self.timing=self.next_timing
        # A fresh acoustic wake is user speech even if VAD missed its short syllable.
        self.last_voice=now
        self.begin(now,'wake')
        return True

    def preview_voice(self, now):
        if self.generation == 0 or not math.isfinite(now):
            return False
        if self.state in ('capturing','processing','speaking'):
            self.event('turn-cancelled',reason='manual-wake')
        if self.interruption:
            self.interruption.clear(now=now)
        self.pre_roll.clear()
        self.candidate=None
        self.recovery_since=None
        self.answer_completed=False
        self.turn+=1
        self.state='processing'
        self.waiting_since=now
        self.dismiss_pending=True
        self.event('voice-preview')
        return True

    def manual_wake(self, now):
        if self.generation == 0 or not math.isfinite(now):
            return False
        if self.interruption:
            self.interruption.clear(now=now)
        if self.state in ('capturing', 'processing', 'speaking'):
            self.event('turn-cancelled', reason='manual-wake')
        self.timing=self.next_timing
        self.dismiss_pending = False
        self.recovery_since = None
        self.answer_completed = False
        self.state = 'listening'
        self.pre_roll.clear()
        self.candidate = self.started = self.waiting_since = None
        self.last_voice = now
        self.event('listening', reason='manual-wake')
        return True

    def fail_answer(self, generation, turn, now):
        if generation != self.generation or turn != self.turn or not math.isfinite(now):
            return False
        if self.state != 'capturing':
            return self.finish_answer(generation, turn, now)
        if not self.timing.continuous:
            self.dismiss()
            return True
        if self.interruption:
            self.interruption.clear(now=now)
        self.state='listening'
        self.pre_roll.clear()
        self.candidate=self.started=self.waiting_since=None
        self.answer_completed=False
        self.recovery_since=now
        self.event('listening')
        return True

    def finish_answer(self, generation, turn, now):
        if generation!=self.generation or turn!=self.turn or self.state not in ('processing','speaking'):
            return False
        if self.answer_completed:
            return False
        # A user may speak over the last audio frame. Preserve the bounded
        # recognition candidate rather than dropping their next utterance.
        if self.interruption and self.interruption.key and not self.dismiss_pending:
            self.answer_completed = True
            return True
        if self.interruption:
            self.interruption.clear(now=now)
        if self.dismiss_pending or not self.timing.continuous:
            self.dismiss()
            return True
        self.state='listening'
        self.waiting_since=None
        self.candidate=None
        self.pre_roll.clear()
        # The assistant's own speech does not extend last_voice.
        self.tick(now)
        if self.state == 'listening':
            self.event('listening')
        return True

    def speaking(self, generation, turn):
        if generation==self.generation and turn==self.turn and self.state=='processing':
            self.state='speaking'
            return True
        return False

    def request_dismiss(self, generation, turn):
        if generation != self.generation or turn != self.turn or self.state not in ('processing', 'speaking'):
            return False
        self.dismiss_pending = True
        return True

    def dismiss(self):
        self.recovery_since=None
        self.answer_completed=False
        if self.interruption:
            self.interruption.clear()
        if self.state in ('capturing','processing','speaking'):
            self.event('turn-cancelled',reason='dismissed')
        self.state='standby'
        self.pre_roll.clear()
        self.candidate=None
        self.event('standby',reason='dismissed')

    def tick(self, now):
        timed_out = False
        if self.interruption:
            self.interruption.tick(now)
        if self.answer_completed and (not self.interruption or self.interruption.key is None):
            self.answer_completed=False
            self.finish_answer(self.generation,self.turn,now)
            return
        if self.state in ('processing','speaking'):
            if not self.timing.owner_managed and self.waiting_since is not None and now-self.waiting_since>=self.timing.work_timeout:
                if self.dismiss_pending or not self.timing.continuous:
                    self.dismiss()
                    return
                self.event('turn-cancelled',reason='work-timeout')
                if self.interruption:
                    self.interruption.clear(now=now)
                self.state='listening'
                self.waiting_since=self.candidate=self.started=None
                self.pre_roll.clear()
                self.recovery_since=None
                self.answer_completed=False
                timed_out = True
            else:
                return
        if self.state=='listening' and self.last_voice is not None and now-self.last_voice>=self.timing.idle_seconds:
            self.turn+=1
            self.state='processing'
            self.waiting_since=now
            self.dismiss_pending=True
            self.pre_roll.clear()
            self.candidate=None
            self.event('idle-farewell',reason='idle')
        elif timed_out:
            self.event('listening',reason='work-timeout')

    def feed(self, pcm, now, voiced, rendered=False):
        if len(pcm)!=320 or not isinstance(pcm,bytes):
            raise ValueError('Expected 10ms PCM16 mono 16kHz')
        if not math.isfinite(now) or (self.last_frame is not None and now<=self.last_frame):
            raise ValueError('Non-monotonic frame')
        self.last_frame=now
        if self.state in ('processing','speaking'):
            if self.dismiss_pending:
                self.pre_roll.append((now,pcm))
            elif self.interruption and self.barge_in_enabled:
                self.interruption.feed(self.generation,self.turn,pcm,now,voiced)
            self.tick(now)
            return
        # After an early ASR failure, never reinterpret the remaining half-sentence.
        if self.recovery_since is not None:
            if voiced and not rendered:
                self.recovery_since=now
                self.last_voice=now
            elif now-self.recovery_since>=self.timing.end_silence:
                self.recovery_since=None
            self.tick(now)
            return
        self.pre_roll.append((now,pcm))
        # Own playback cannot start a fresh turn until AEC barge-in is validated.
        if voiced and not rendered:
            self.candidate=now if self.candidate is None else self.candidate
            if now-self.candidate>=self.timing.min_voice-1e-6:
                if self.state=='listening':
                    previous_voice=self.last_voice
                    self.last_voice=now
                    self.begin(now,'speech',previous_voice)
                    return  # current frame was included in pre-roll
                self.last_voice=now
        else:
            self.candidate=None
        if self.state=='capturing':
            self.audio_sink(self.generation,self.turn,pcm,now)
            self.pre_roll.clear()
            if voiced and not rendered:
                self.voiced_duration+=.01
            if now-self.started>=self.timing.max_utterance or (self.last_voice is not None and now-self.last_voice>=self.timing.end_silence):
                if self.capture_reason=='speech' and self.voiced_duration<max(.32,self.timing.min_voice):
                    # Keyboard clicks and breath bursts often pass the initial VAD
                    # debounce. Cancel before ASR can hallucinate a spoken request.
                    self.event('turn-cancelled',reason='short-noise')
                    self.state='listening'
                    self.started=self.waiting_since=self.candidate=None
                    self.capture_reason=None
                    self.voiced_duration=0
                    self.last_voice=self.last_voice_before_capture
                    self.last_voice_before_capture=None
                    self.pre_roll.clear()
                else:
                    self.state='processing'
                    self.waiting_since=now
                    self.last_voice_before_capture=None
                    self.event('turn-end',reason='max-duration' if now-self.started>=self.timing.max_utterance else 'silence')
        self.tick(now)

    def resolve_interruption(self, generation, turn, pause_id, decision, now):
        if (not self.interruption or generation != self.generation or turn != self.turn
                or self.state not in ('processing','speaking') or decision not in ('resume','interrupt','stop')
                or not math.isfinite(now)):
            return False
        frames = self.interruption.take(generation,turn,pause_id,now)
        if frames is None:
            return False
        if decision == 'resume':
            self.event('interruption-cancelled',pauseId=pause_id,reason='resolved')
            if self.answer_completed:
                self.recovery_since=None
                self.answer_completed=False
                self.finish_answer(generation,turn,now)
            return True
        self.recovery_since=None
        self.answer_completed=False
        self.event('turn-cancelled',reason='interrupted')
        self.pre_roll.clear()
        self.candidate = self.started = self.waiting_since = None
        self.last_voice = now
        self.state = 'listening'
        if decision == 'stop':
            if not self.timing.continuous:
                self.dismiss()
            else:
                self.event('listening',reason='interrupted')
        else:
            self.pre_roll.extend(frames)
            self.begin(now,'interruption')
        return True
