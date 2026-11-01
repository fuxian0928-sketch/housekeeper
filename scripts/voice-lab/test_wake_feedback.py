import unittest
import numpy as np
from wake_feedback import WakeFeedback


class WakeFeedbackTests(unittest.TestCase):
    def test_local_clip_is_bounded_smooth_and_submitted_without_provider_work(self):
        cue = WakeFeedback()
        self.assertTrue(cue.trigger(1, 10))
        audio = np.concatenate([cue.render(1, 10 + .01 * i) for i in range(12)])
        self.assertEqual(len(audio), 1920)
        self.assertEqual(audio.dtype, np.float32)
        self.assertLessEqual(float(np.max(np.abs(audio))), .121)
        self.assertEqual(audio[0], 0)
        self.assertLess(abs(audio[-1]), .001)
        self.assertGreater(float(np.sqrt(np.mean(audio**2))), .05)
        self.assertFalse(cue.render(1, 10.13).any())
        self.assertEqual(cue.report()['submittedFrames'], 12)
        self.assertEqual(cue.report()['lastFirstFrameMs'], 0)

    def test_expired_cue_is_dropped_instead_of_playing_after_a_device_stall(self):
        cue = WakeFeedback(); cue.trigger(1, 10)
        self.assertFalse(cue.render(1, 11).any())
        self.assertEqual(cue.report()['expiredClips'], 1)
        self.assertEqual(cue.report()['submittedFrames'], 0)

    def test_cancel_generation_change_and_duplicate_trigger_do_not_queue_audio(self):
        cue = WakeFeedback(); cue.trigger(1, 10)
        self.assertFalse(cue.trigger(1, 10.1))
        self.assertFalse(cue.render(2, 10.2).any())
        self.assertTrue(cue.trigger(2, 11))
        self.assertFalse(cue.trigger(1, 12))
        cue.cancel(); self.assertFalse(cue.render(2, 11.1).any())
        self.assertEqual(cue.report()['triggers'], 2)

    def test_non_monotonic_or_invalid_clock_never_plays(self):
        for now in [float('nan'), float('inf'), 9]:
            cue = WakeFeedback(); cue.trigger(1, 10)
            self.assertFalse(cue.render(1, now).any())
        self.assertFalse(WakeFeedback().trigger(0, 10))


if __name__ == '__main__': unittest.main()
