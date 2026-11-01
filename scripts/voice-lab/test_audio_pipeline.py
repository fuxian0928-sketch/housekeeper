import unittest
import numpy as np
from audio_pipeline import EchoPipeline, FreshFrameQueue


class PipelineTests(unittest.TestCase):
    def test_processing_options_with_real_processor(self):
        pcm = np.zeros(160, np.float32)
        for noise in (False, True):
            for gain in (False, True):
                pipeline = EchoPipeline(delay_ms=80, noise_suppression=noise, auto_gain=gain)
                for _ in range(10):
                    clean = pipeline.process(pcm, pcm)
                    self.assertEqual(clean.shape, (160,))
                    self.assertTrue(np.isfinite(clean).all())
        for kwargs in ({'delay_ms': -1}, {'delay_ms': 251}, {'noise_suppression': 'yes'}, {'auto_gain': 1}):
            with self.assertRaises(ValueError):
                EchoPipeline(**kwargs)

    def test_expired_audio_is_not_replayed_after_five_minutes(self):
        now = [0.0]
        queue = FreshFrameQueue(clock=lambda: now[0])
        queue.push(np.zeros(160, np.float32), 0)
        now[0] = 300
        self.assertIsNone(queue.pop())
        self.assertEqual(queue.dropped, 1)

    def test_bounded_queue_retains_latest_audio_and_copies_callback_buffer(self):
        queue = FreshFrameQueue(max_frames=2, clock=lambda: 0)
        pcm = np.zeros(160, np.float32)
        for _ in range(3):
            queue.push(pcm, 0)
        pcm[:] = 1
        self.assertEqual(len(queue.frames), 2)
        self.assertEqual(queue.dropped, 1)
        self.assertTrue(np.all(queue.pop()[1] == 0))
        queue.clear()
        self.assertIsNone(queue.pop())

    def test_missing_or_wrong_reference_is_not_silently_accepted(self):
        pipeline = EchoPipeline()
        pcm = np.zeros(160, np.float32)
        for wrong in (np.zeros(480, np.float32), np.zeros(160, np.int16), np.full(160, np.nan, np.float32)):
            with self.assertRaises(ValueError):
                pipeline.process(pcm, wrong)
        self.assertEqual(pipeline.process(pcm, pcm).shape, (160,))


if __name__ == '__main__':
    unittest.main()
