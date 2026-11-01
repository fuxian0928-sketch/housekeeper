import unittest
from turn_segmenter import TurnSegmenter
from playback_buffer import PlaybackBuffer
from interruption_control import pause_candidate


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.output = PlaybackBuffer()
        self.events, self.handoff_audio, self.during_events = [], [], []
        def emit(event):
            self.events.append(event)
            if event['type'] in ('turn-start','turn-cancelled','standby'):
                self.output.cancel()
            if event['type'] == 'interruption-cancelled':
                self.output.resume(event['generation'],event['turn'],event['pauseId'])
            # Model an audio callback racing between any two lifecycle events.
            if self.output.key:
                self.during_events.append(self.output.render(now=3.3).copy())
        self.s = TurnSegmenter(emit,lambda *x:self.handoff_audio.append(x),interruption_sink=lambda *x:None)
        self.s.reset(1); self.s.wake(1); self.s.feed(bytes(320),2.1,False); self.s.speaking(1,1)
        self.output.start(1,1)
        for i in range(15): self.s.feed(bytes([i])*320,3+i*.01,True,True)
        self.output.append(1,1,0,b'\x00\x40'*1600)
        self.assertTrue(pause_candidate(self.s,self.output,1,1,1,3.15))
        self.events.clear(); self.during_events.clear(); self.handoff_audio.clear()

    def test_confirmation_cancels_without_briefly_resuming_old_audio(self):
        self.assertTrue(self.s.resolve_interruption(1,1,1,'interrupt',3.2))
        self.assertEqual([e['type'] for e in self.events],['turn-cancelled','turn-start'])
        self.assertFalse(any(frame.any() for frame in self.during_events))
        self.assertEqual(len(self.handoff_audio),15)
        self.assertEqual(self.s.turn,2)
        self.assertTrue(self.output.start(1,2))
        self.assertFalse(self.output.resume(1,1,1))
        self.assertFalse(pause_candidate(self.s,self.output,1,1,1,3.3))

    def test_acknowledgement_resumes_original_buffer(self):
        self.assertTrue(self.s.resolve_interruption(1,1,1,'resume',3.2))
        self.assertEqual(self.output.key,(1,1))
        self.assertTrue(any(frame.any() for frame in self.during_events))
        self.assertEqual(self.handoff_audio,[])

    def test_stop_cannot_leak_old_audio_between_events(self):
        self.assertTrue(self.s.resolve_interruption(1,1,1,'stop',3.2))
        self.assertEqual([e['type'] for e in self.events],['turn-cancelled','listening'])
        self.assertFalse(any(frame.any() for frame in self.during_events))

    def test_answer_completion_preserves_candidate_until_confirmed(self):
        self.assertTrue(self.s.finish_answer(1,1,3.16))
        self.assertIsNotNone(self.s.interruption.key)
        self.assertFalse(self.s.finish_answer(1,1,3.17))
        self.assertTrue(self.s.resolve_interruption(1,1,1,'interrupt',3.2))
        self.assertEqual(self.s.turn,2)
        self.assertEqual(self.s.state,'capturing')
        self.assertEqual(len(self.handoff_audio),15)

    def test_answer_completion_and_backchannel_returns_to_listening(self):
        self.assertTrue(self.s.finish_answer(1,1,3.16))
        self.assertTrue(self.s.resolve_interruption(1,1,1,'resume',3.2))
        self.assertEqual(self.s.state,'listening')
        self.assertEqual(self.s.turn,1)
        self.assertFalse(self.s.finish_answer(1,1,3.3))

    def test_answer_completion_candidate_timeout_returns_to_listening(self):
        self.assertTrue(self.s.finish_answer(1,1,3.16))
        self.s.tick(4.4)
        self.assertEqual(self.s.state,'listening')
        self.assertIsNone(self.s.interruption.key)
        self.assertFalse(self.s.resolve_interruption(1,1,1,'interrupt',4.5))

    def test_manual_wake_clears_completion_pending_and_rejects_old_handoff(self):
        self.s.finish_answer(1,1,3.16)
        self.assertTrue(self.s.answer_completed)
        self.s.manual_wake(3.17)
        self.assertFalse(self.s.answer_completed)
        self.assertFalse(self.s.resolve_interruption(1,1,1,'interrupt',3.2))
        self.assertEqual(self.s.state,'listening')

    def test_processing_phase_collects_and_hands_off_new_instruction(self):
        self.s=TurnSegmenter(self.events.append,lambda *x:self.handoff_audio.append(x),interruption_sink=lambda *x:None)
        self.s.reset(2);self.s.wake(1);self.s.feed(bytes(320),2.1,False)
        self.assertEqual(self.s.state,'processing')
        for i in range(15):self.s.feed(bytes(320),3+i*.01,True)
        event=next(e for e in reversed(self.events) if e['type']=='interruption-start')
        self.assertEqual(event['phase'],'processing')
        before=len(self.handoff_audio)
        self.assertTrue(self.s.resolve_interruption(2,1,event['pauseId'],'interrupt',3.2))
        self.assertEqual(self.s.state,'capturing');self.assertEqual(self.s.turn,2)
        self.assertEqual(len(self.handoff_audio)-before,15)
        self.assertFalse(self.s.finish_answer(2,1,3.3))

    def test_processing_backchannel_keeps_original_work(self):
        self.s.state='processing'
        self.assertTrue(self.s.resolve_interruption(1,1,1,'resume',3.2))
        self.assertEqual(self.s.state,'processing');self.assertEqual(self.s.turn,1)

    def test_expired_candidate_cannot_pause_again(self):
        self.s.tick(4.4)
        self.assertFalse(pause_candidate(self.s,self.output,1,1,1,4.5))
        self.assertIsNone(self.output.pause_deadline)
        self.assertFalse(self.s.resolve_interruption(1,1,1,'interrupt',4.5))


if __name__ == '__main__': unittest.main()
