import unittest
from worker import WakeSession


class WakeSessionTests(unittest.TestCase):
    def test_ring_is_bounded_and_reset_erases_old_audio(self):
        state = WakeSession()
        state.reset(1)
        for sequence in range(1, 1000):
            state.accept(1, sequence, b'\x00\x01' * 320)
        self.assertEqual(len(state.ring), 48000)
        state.reset(2)
        self.assertEqual(len(state.ring), 0)

    def test_two_keywords_in_one_utterance_emit_one_wake(self):
        state = WakeSession()
        state.reset(1)
        self.assertTrue(state.trigger())
        self.assertFalse(state.trigger())
        self.assertFalse(state.reset(1))
        self.assertFalse(state.trigger())
        state.reset(2)
        self.assertTrue(state.trigger())

    def test_old_or_duplicate_pcm_is_rejected(self):
        state = WakeSession()
        state.reset(2)
        self.assertFalse(state.accept(1, 999, b'\x00\x00'))
        self.assertTrue(state.accept(2, 1, b'\x00\x00'))
        self.assertFalse(state.accept(2, 1, b'\x00\x00'))
        self.assertEqual(len(state.ring), 2)

    def test_invalid_frame_has_no_partial_mutation(self):
        state = WakeSession()
        state.reset(1)
        for pcm in [b'', b'x', bytes(3202)]:
            with self.assertRaises(ValueError):
                state.accept(1, 1, pcm)
        self.assertEqual(state.sequence, 0)
        self.assertEqual(len(state.ring), 0)


if __name__ == '__main__':
    unittest.main()
