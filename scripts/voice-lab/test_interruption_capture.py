import unittest
from turn_segmenter import TurnSegmenter


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.events, self.candidates, self.audio = [], [], []
        self.s = TurnSegmenter(self.events.append, lambda *x: self.audio.append(x),
                               interruption_sink=lambda *x: self.candidates.append(x))
        self.s.reset(1)
        self.s.wake(1)
        self.s.feed(bytes(320),2.1,False)
        self.s.speaking(1,1)
        self.events.clear(); self.audio.clear()

    def speak(self):
        for i in range(15): self.s.feed(bytes([i])*320,3+i*.01,True,True)

    def test_short_noise_does_not_open_candidate(self):
        for i in range(10): self.s.feed(bytes(320),3+i*.01,True,True)
        self.s.feed(bytes(320),3.1,False,True)
        self.assertEqual(self.candidates, [])

    def test_candidate_does_not_create_turn_until_confirmed_and_replays_prefix(self):
        self.speak()
        self.assertEqual(self.s.turn,1)
        self.assertEqual(self.audio,[])
        self.assertEqual(self.events[0]['type'],'interruption-start')
        self.assertTrue(self.s.resolve_interruption(1,1,1,'interrupt',3.2))
        self.assertEqual(self.s.turn,2)
        self.assertEqual(self.s.state,'capturing')
        self.assertEqual([a[2] for a in self.audio],[bytes([i])*320 for i in range(15)])

    def test_resume_keeps_old_turn_and_releases_audio(self):
        self.speak()
        self.assertTrue(self.s.resolve_interruption(1,1,1,'resume',3.2))
        self.assertEqual(self.s.state,'speaking'); self.assertEqual(self.s.turn,1)
        self.assertEqual(len(self.s.interruption.frames),0)

    def test_stop_returns_to_listening_without_forwarding_command(self):
        self.speak(); self.s.resolve_interruption(1,1,1,'stop',3.2)
        self.assertEqual(self.s.state,'listening'); self.assertEqual(self.audio,[])

    def test_timeout_and_old_decisions_cannot_cancel_newer_turn(self):
        self.speak(); self.s.tick(4.4)
        self.assertFalse(self.s.resolve_interruption(1,1,1,'interrupt',4.4))
        self.assertEqual(len(self.s.interruption.frames),0)
        self.s.manual_wake(4.5)
        self.assertFalse(self.s.resolve_interruption(1,1,1,'stop',4.6))

    def test_end_is_sent_once_and_later_audio_is_retained_for_handoff(self):
        self.speak()
        for i in range(15,50): self.s.feed(bytes([i])*320,3+i*.01,False,True)
        self.assertEqual(sum(e['type']=='interruption-end' for e in self.events),1)
        sent=len(self.candidates)
        self.s.feed(b'z'*320,3.51,True,True)
        self.assertEqual(len(self.candidates),sent)
        self.s.resolve_interruption(1,1,1,'interrupt',3.52)
        self.assertEqual(self.audio[-1][2],b'z'*320)

    def test_reset_discards_candidate_and_completion_clears_it(self):
        self.speak(); self.s.reset(2)
        self.assertEqual(len(self.s.interruption.frames),0)
        self.assertFalse(self.s.resolve_interruption(1,1,1,'interrupt',3.2))


if __name__ == '__main__': unittest.main()
