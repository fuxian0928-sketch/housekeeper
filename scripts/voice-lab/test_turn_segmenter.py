import unittest
from turn_segmenter import TurnSegmenter,TurnTiming


class SegmentTests(unittest.TestCase):
    def setUp(self):
        self.events=[]; self.audio=[]
        self.s=TurnSegmenter(self.events.append,lambda g,t,p,at:self.audio.append((g,t,p,at)))
        self.s.reset(1)

    def test_desktop_owner_keeps_long_processing_and_playback_until_receipt(self):
        self.s.configure(TurnTiming(owner_managed=True))
        self.s.wake(0)
        self.s.feed(bytes(320),1.1,False)
        self.s.tick(29)
        self.assertEqual(self.s.state,'processing')
        self.assertTrue(self.s.speaking(1,1))
        for now in (31.2,60.1,90.1,120.1):
            self.s.tick(now)
            self.assertEqual(self.s.state,'speaking')
        self.assertFalse(any(e.get('reason')=='work-timeout' for e in self.events))
        self.assertTrue(self.s.finish_answer(1,1,121))
        self.assertEqual(self.s.state,'listening')
        self.assertFalse(self.s.finish_answer(1,1,122))

    def test_managed_deadline_does_not_disable_explicit_failure_dismissal_or_idle(self):
        self.s.configure(TurnTiming(owner_managed=True))
        self.s.wake(0);self.s.feed(bytes(320),1.1,False)
        self.s.tick(100)
        self.assertTrue(self.s.fail_answer(1,1,101))
        self.assertEqual(self.s.state,'listening')
        self.s.tick(300)
        self.assertEqual(self.events[-1]['type'],'idle-farewell')
        self.s.tick(350)
        self.assertTrue(self.s.finish_answer(1,2,351))
        self.assertEqual(self.s.state,'standby')
        for value in ('true',1,None):
            with self.assertRaises(ValueError):TurnTiming(owner_managed=value)

    def test_single_turn_returns_to_standby_after_output_and_requires_rewake(self):
        self.s.configure(TurnTiming(continuous=False))
        self.s.wake(0)
        self.s.feed(bytes(320),1.1,False)
        self.s.speaking(1,1)
        self.assertEqual(self.s.state,'speaking')
        self.assertFalse(self.s.finish_answer(1,0,2))
        self.assertTrue(self.s.finish_answer(1,1,2))
        self.assertEqual(self.s.state,'standby')
        for i in range(30):self.s.feed(bytes(320),2.1+i*.01,True)
        self.assertEqual(self.s.turn,1)
        self.assertTrue(self.s.wake(3))
        self.assertEqual(self.s.turn,2)
        self.assertFalse(any(e['type']=='idle-farewell' for e in self.events))

    def test_continuous_change_is_deferred_until_next_wake(self):
        self.s.wake(0)
        self.s.configure(TurnTiming(continuous=False))
        self.s.feed(bytes(320),1.1,False)
        self.s.finish_answer(1,1,2)
        self.assertEqual(self.s.state,'listening')
        self.s.dismiss();self.s.wake(3)
        self.assertFalse(self.s.timing.continuous)
        for value in ('false',0,None):
            with self.assertRaises(ValueError):TurnTiming(continuous=value)

    def test_single_turn_failure_and_timeout_do_not_keep_listening(self):
        self.s.configure(TurnTiming(continuous=False))
        self.s.wake(0)
        self.s.fail_answer(1,1,.1)
        self.assertEqual(self.s.state,'standby')
        self.s.wake(1);self.s.feed(bytes(320),2.1,False)
        self.s.tick(33)
        self.assertEqual(self.s.state,'standby')

    def test_minimum_voice_change_applies_next_wake_and_filters_short_noise(self):
        self.s.manual_wake(0)
        self.s.configure(TurnTiming(min_voice=.5))
        # An active session keeps its threshold, avoiding mid-utterance changes.
        self.assertEqual(self.s.timing.min_voice, .12)
        self.s.dismiss()
        self.s.manual_wake(.1)
        self.assertEqual(self.s.timing.min_voice, .5)
        for i in range(40): self.s.feed(bytes(320), .2+i*.01, True)
        self.assertEqual(self.s.state, 'listening')
        self.s.feed(bytes(320), .7, False)
        for i in range(51): self.s.feed(b'y'*320, .8+i*.01, True)
        self.assertEqual(self.s.state, 'capturing')
        self.assertEqual(self.s.turn, 1)

    def test_continuous_listening_cancels_short_vad_bursts_but_keeps_speech(self):
        self.s.manual_wake(0)
        for i in range(18): self.s.feed(bytes(320), .1+i*.01, True)
        self.assertEqual(self.s.state, 'capturing')
        self.s.feed(bytes(320), 1.3, False)
        self.assertEqual(self.s.state, 'listening')
        self.assertEqual(self.events[-1]['type'], 'turn-cancelled')
        self.assertEqual(self.events[-1]['reason'], 'short-noise')
        self.assertEqual(self.s.last_voice, 0)
        self.assertFalse(any(e['type']=='turn-end' for e in self.events))
        for i in range(40): self.s.feed(bytes(320), 1.4+i*.01, True)
        self.s.feed(bytes(320), 2.8, False)
        self.assertEqual(self.s.state, 'processing')
        self.assertEqual(self.events[-1]['type'], 'turn-end')

    def test_capture_failure_discards_tail_then_accepts_next_complete_utterance(self):
        self.s.wake(0)
        self.s.feed(bytes(320), .1, True)
        self.assertTrue(self.s.fail_answer(1, 1, .2))
        count=len(self.audio)
        for i in range(100): self.s.feed(b'x'*320, .3+i*.01, True)
        self.assertEqual(len(self.audio), count)
        self.assertEqual(self.s.turn, 1)
        self.s.feed(bytes(320), 2.4, False)
        self.assertIsNone(self.s.recovery_since)
        for i in range(20): self.s.feed(b'y'*320, 2.5+i*.01, True)
        self.assertEqual(self.s.turn, 2)
        self.assertEqual(self.s.state, 'capturing')
        self.assertNotIn(b'x'*320, [a[2] for a in self.audio[count:]])
        self.assertFalse(self.s.fail_answer(1, 1, 2.8))
        self.assertEqual(self.s.state, 'capturing')

    def test_capture_failure_manual_wake_overrides_silence_gate(self):
        self.s.wake(0)
        self.s.fail_answer(1, 1, .1)
        self.s.manual_wake(.2)
        self.assertIsNone(self.s.recovery_since)
        for i in range(20): self.s.feed(bytes(320), .3+i*.01, True)
        self.assertEqual(self.s.turn, 2)

    def test_voice_preview_retires_capture_clears_audio_and_returns_to_standby(self):
        self.s.wake(0)
        self.s.feed(bytes(320),.1,True)
        previous=self.s.turn
        self.assertTrue(self.s.preview_voice(.2))
        self.assertEqual(self.events[-2]['type'],'turn-cancelled')
        self.assertEqual(self.events[-1]['type'],'voice-preview')
        self.assertGreater(self.s.turn,previous)
        self.assertEqual(len(self.s.pre_roll),0)
        self.assertTrue(self.s.dismiss_pending)
        self.assertFalse(self.s.finish_answer(1,previous,.3))
        self.assertTrue(self.s.finish_answer(1,self.s.turn,.4))
        self.assertEqual(self.s.state,'standby')

    def test_manual_wake_waits_for_voice_and_discards_standby_audio(self):
        self.s.feed(b'x'*320, 0, False)
        self.assertTrue(self.s.manual_wake(.1))
        self.assertEqual(self.s.state, 'listening')
        self.assertEqual(self.s.turn, 0)
        self.assertEqual(self.audio, [])
        for i in range(20): self.s.feed(bytes(320), .2+i*.01, True)
        self.assertEqual(self.s.turn, 1)
        self.assertEqual(self.s.state, 'capturing')
        self.assertNotIn(b'x'*320, [a[2] for a in self.audio])

    def test_manual_wake_cancels_processing_and_old_completion_cannot_end_new_turn(self):
        self.s.wake(0)
        self.s.feed(bytes(320), 1.1, False)
        self.s.speaking(1, 1)
        self.assertTrue(self.s.manual_wake(2))
        self.assertEqual(self.events[-2]['type'], 'turn-cancelled')
        self.assertEqual(self.events[-1]['type'], 'listening')
        self.assertFalse(self.s.finish_answer(1, 1, 2.1))
        for i in range(20): self.s.feed(bytes(320), 3+i*.01, True)
        self.assertEqual(self.s.turn, 2)
        self.assertFalse(self.s.finish_answer(1, 1, 3.3))
        self.assertEqual(self.s.state, 'capturing')

    def test_manual_wake_idle_expires_after_five_minutes(self):
        self.s.manual_wake(10)
        self.s.tick(309)
        self.assertEqual(self.s.state, 'listening')
        self.s.tick(310)
        self.assertEqual(self.s.state, 'processing')
        self.assertEqual(self.events[-1]['type'], 'idle-farewell')
        self.s.tick(311)
        self.assertEqual(len([e for e in self.events if e['type']=='idle-farewell']), 1)
        self.s.tick(341)
        self.assertEqual(self.s.state, 'standby')

    def test_dismissal_timeout_returns_to_standby_and_manual_wake_clears_it(self):
        self.s.wake(0); self.s.feed(bytes(320), 1.1, False)
        self.assertFalse(self.s.request_dismiss(2, 1))
        self.assertTrue(self.s.request_dismiss(1, 1))
        self.s.tick(32)
        self.assertEqual(self.s.state, 'standby')
        self.s.manual_wake(33)
        self.assertFalse(self.s.dismiss_pending)
        self.assertEqual(self.s.state, 'listening')

    def test_farewell_cannot_be_acoustically_rewoken_until_playback_finishes(self):
        self.s.manual_wake(0); self.s.tick(300)
        self.assertEqual(self.s.turn, 1)
        self.s.feed(b'x'*320, 300.1, True)
        self.assertFalse(self.s.wake(300.1))
        self.assertTrue(self.s.finish_answer(1, 1, 301))
        self.assertEqual(self.s.state, 'standby')
        self.assertTrue(self.s.wake(302))
        self.assertEqual(self.s.turn, 2)
        self.assertFalse(self.s.dismiss_pending)
        self.assertFalse(self.s.finish_answer(1, 1, 303))
        self.assertEqual(self.s.state, 'capturing')

    def test_farewell_completion_is_standby_without_another_idle_farewell(self):
        self.s.manual_wake(0); self.s.tick(300)
        self.assertTrue(self.s.finish_answer(1, 1, 301))
        self.assertEqual(self.s.state, 'standby')
        self.s.tick(1000)
        self.assertEqual(len([e for e in self.events if e['type']=='idle-farewell']), 1)

    def test_configured_utterance_limit_waits_for_next_wake_and_emits_limit_reason(self):
        self.s.wake(0)
        self.s.configure(TurnTiming(max_utterance=5))
        self.assertEqual(self.s.timing.max_utterance,30)
        self.s.dismiss(); self.s.wake(1)
        for i in range(1,502):
            self.s.feed(bytes(320),1+i*.01,True)
        ends=[e for e in self.events if e['type']=='turn-end']
        self.assertEqual(len(ends),1)
        self.assertEqual(ends[0]['reason'],'max-duration')
        self.assertEqual(self.s.state,'processing')
        for value in [4,31,float('inf')]:
            with self.assertRaises(ValueError): TurnTiming(max_utterance=value)

    def test_saved_timing_applies_at_next_wake_not_mid_sentence(self):
        self.s.wake(0)
        self.s.configure(TurnTiming(idle_seconds=600, end_silence=2))
        self.assertEqual(self.s.timing.end_silence, 1)
        self.s.feed(bytes(320), 1.1, False)
        self.assertEqual(self.s.state, 'processing')
        self.s.dismiss(); self.s.wake(3)
        self.assertEqual(self.s.timing.idle_seconds, 600)
        self.s.feed(bytes(320), 4.1, False)
        self.assertEqual(self.s.state, 'capturing')
        self.s.feed(bytes(320), 5.1, False)
        self.assertEqual(self.s.state, 'processing')
        self.s.manual_wake(10); self.s.tick(310)
        self.assertEqual(self.s.state, 'listening')
        self.s.tick(610)
        self.assertEqual(self.events[-1]['type'], 'idle-farewell')

    def test_wake_pre_roll_is_once_and_following_body_is_retained(self):
        for i in range(160):
            self.s.feed(bytes([i%256])*320,i*.01,True)
        self.s.wake(1.59)
        self.assertEqual(len(self.audio),150)
        self.assertAlmostEqual(self.audio[0][3],.1)
        self.assertFalse(self.s.wake(1.6))
        self.s.feed(b'x'*320,1.6,True)
        self.assertEqual(len(self.audio),151)
        self.assertEqual(self.audio[-1][2],b'x'*320)

    def test_silence_finishes_once_and_next_turn_requires_answer_completion(self):
        self.s.wake(0)
        for i in range(1,102):self.s.feed(bytes(320),i*.01,False)
        self.assertEqual(self.s.state,'processing')
        count=len(self.audio)
        self.s.feed(bytes(320),1.03,True)
        self.assertEqual(len(self.audio),count)
        self.assertFalse(self.s.finish_answer(0,1,2))
        self.assertTrue(self.s.finish_answer(1,1,2))
        for i in range(15):self.s.feed(bytes(320),2.1+i*.01,True)
        self.assertEqual(self.s.turn,2)
        self.assertEqual(len([e for e in self.events if e['type']=='turn-end']),1)

    def test_idle_clock_ignores_own_output_and_work_does_not_get_farewell(self):
        self.s.wake(0);self.s.feed(bytes(320),1.1,False)
        self.s.waiting_since=295; self.s.last_voice=0
        self.s.tick(301)
        self.assertEqual(self.s.state,'processing')
        self.s.finish_answer(1,1,302)
        self.assertEqual(self.s.state,'processing')
        self.assertEqual(self.s.turn,2)
        self.assertEqual(self.events[-1]['reason'],'idle')

    def test_self_output_does_not_start_turn(self):
        self.s.wake(0);self.s.feed(bytes(320),1.1,False)
        self.s.finish_answer(1,1,2)
        for i in range(20):self.s.feed(bytes(320),2.1+i*.01,True,rendered=True)
        self.assertEqual(self.s.state,'listening')

    def test_discontinuity_cancels_and_erases_old_audio(self):
        self.s.wake(0);self.s.feed(bytes(320),.01,True)
        self.s.reset(2)
        self.assertEqual(self.events[-1]['type'],'turn-cancelled')
        self.assertEqual(self.s.state,'standby')
        self.assertFalse(self.s.finish_answer(1,1,1))
        self.assertEqual(len(self.s.pre_roll),0)

    def test_long_utterance_is_bounded(self):
        self.s.wake(0)
        for i in range(1,3002):self.s.feed(bytes(320),i*.01,True)
        self.assertEqual(self.s.state,'processing')
        self.assertEqual(self.events[-1]['reason'],'max-duration')

    def test_timeout_reenters_listening_with_fresh_voice_debounce(self):
        self.s.wake(0)
        # Max-duration capture ends while speech detection is still active.
        for i in range(1,3001): self.s.feed(bytes(320),i*.01,True)
        self.assertEqual(self.s.state,'processing')
        self.s.tick(60.01)
        self.assertEqual(self.events[-1]['type'],'listening')
        self.assertEqual(self.events[-1]['reason'],'work-timeout')
        self.assertIsNone(self.s.candidate)
        self.assertIsNone(self.s.started)
        self.assertFalse(self.s.finish_answer(1,1,60.02))
        self.s.feed(bytes(320),60.03,True)
        self.assertEqual(self.s.state,'listening')
        for i in range(1,14): self.s.feed(bytes(320),60.03+i*.01,True)
        self.assertEqual(self.s.turn,2)
        self.assertEqual(self.s.state,'capturing')

    def test_timeout_retires_pending_interruption_and_late_resolution(self):
        self.s=TurnSegmenter(self.events.append,lambda *args:None,interruption_sink=lambda *args:None)
        self.s.reset(1);self.s.wake(0);self.s.feed(bytes(320),1.1,False)
        self.s.speaking(1,1)
        for i in range(15): self.s.feed(bytes(320),30.8+i*.01,True)
        key=self.s.interruption.key
        self.assertIsNotNone(key)
        self.s.tick(31.11)
        self.assertIsNone(self.s.interruption.key)
        self.assertFalse(self.s.resolve_interruption(*key,'interrupt',31.12))
        self.assertEqual(self.s.state,'listening')

    def test_timeout_at_idle_deadline_goes_directly_to_single_farewell(self):
        self.s.manual_wake(0)
        self.s.turn=1;self.s.state='processing';self.s.waiting_since=270
        self.events.clear();self.s.tick(301)
        self.assertEqual([e['type'] for e in self.events],['turn-cancelled','idle-farewell'])
        self.assertTrue(self.s.dismiss_pending)
        self.s.tick(302)
        self.assertEqual(len(self.events),2)

    def test_twenty_rounds_continue_after_timeouts_and_reject_late_completions(self):
        self.s.manual_wake(0)
        now=1
        for index in range(20):
            for step in range(40): self.s.feed(bytes(320),now+step*.01,True)
            now+=1.6;self.s.feed(bytes(320),now,False)
            turn=self.s.turn
            self.assertEqual(turn,index+1)
            self.assertEqual(self.s.state,'processing')
            if index%2:
                now+=31;self.s.tick(now)
                self.assertFalse(self.s.finish_answer(1,turn,now+.01))
            else:
                now+=.5;self.assertTrue(self.s.finish_answer(1,turn,now))
            self.assertEqual(self.s.state,'listening')
            self.assertFalse(self.s.speaking(1,turn))
            now+=.5
        self.assertEqual(len([e for e in self.events if e['type']=='turn-start']),20)

    def test_disabling_barge_in_clears_candidate_and_keeps_manual_wake(self):
        self.s=TurnSegmenter(self.events.append,lambda *args:None,interruption_sink=lambda *args:None)
        self.s.reset(1);self.s.wake(0);self.s.feed(bytes(320),1.1,False)
        for i in range(20): self.s.feed(bytes(320),2+i*.01,True)
        key=self.s.interruption.key
        self.assertIsNotNone(key)
        self.s.configure(TurnTiming(barge_in=False))
        self.assertIsNone(self.s.interruption.key)
        self.assertEqual(self.events[-1]['type'],'interruption-cancelled')
        for i in range(100): self.s.feed(bytes(320),3+i*.01,True)
        self.assertIsNone(self.s.interruption.key)
        self.assertFalse(self.s.resolve_interruption(*key,'interrupt',4.1))
        self.s.manual_wake(4.2)
        self.assertEqual(self.s.state,'listening')
        for value in ('false',0,None):
            with self.assertRaises(ValueError): TurnTiming(barge_in=value)

    def test_invalid_config_rejected(self):
        for value in (0,float('nan'),True,2000):
            with self.assertRaises(ValueError):TurnTiming(idle_seconds=value)

    def test_new_wake_does_not_use_previous_sessions_silence_deadline(self):
        self.s.wake(0);self.s.dismiss()
        self.s.wake(400)
        self.s.feed(bytes(320),400.01,False)
        self.assertEqual(self.s.state,'capturing')


if __name__=='__main__':unittest.main()
