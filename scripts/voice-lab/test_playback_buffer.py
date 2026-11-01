import unittest
import numpy as np
from playback_buffer import PlaybackBuffer


class PlaybackTests(unittest.TestCase):
    def test_device_deadlines_are_measured_even_with_a_full_pcm_queue(self):
        output = PlaybackBuffer(); output.start(1, 1)
        actual = []
        for i in range(240):
            if i % 20 == 0:
                self.assertTrue(output.append(1, 1, i // 20, b'\x00\x20' * 3200))
            now = 10 + i * .01 + (.04 if i >= 50 else 0) + (.05 if i >= 210 else 0)
            actual.append(output.render(now=now, output_underflow=i in (50, 210), input_overflow=i == 70))
        health = output.health()
        self.assertEqual(health['underrunCount'], 0)
        self.assertEqual(health['deviceOutputUnderflows'], 2)
        self.assertEqual(health['headOutputUnderflows'], 1)
        self.assertEqual(health['deviceInputOverflows'], 1)
        self.assertEqual(health['deviceLateCallbacks'], 2)
        self.assertEqual(health['headLateCallbacks'], 1)
        self.assertEqual(health['deviceMaxGapMs'], 60)
        self.assertEqual(health['headMaxGapMs'], 50)
        np.testing.assert_array_equal(np.concatenate(actual), np.full(38400, .25, np.float32))
        output.cancel(); output.start(1, 2)
        self.assertEqual(output.health()['headLateCallbacks'], 0)
        self.assertEqual(output.health()['deviceOutputUnderflows'], 0)

    def test_progress_counts_only_previous_callbacks_and_is_coalesced(self):
        output = PlaybackBuffer(); output.start(1,1)
        output.append(1,1,0,bytes(6400)); output.append(1,1,1,bytes(6400))
        output.render(); self.assertIsNone(output.take_progress())
        output.render(); self.assertEqual(output.take_progress(),(1,1,1))
        for _ in range(23): output.render()
        self.assertIsNone(output.take_progress())
        output.render()
        self.assertEqual(output.take_progress(),(1,1,25))
        self.assertIsNone(output.take_progress())
        output.cancel(); self.assertIsNone(output.take_progress())

    def test_pause_resumes_at_exact_sample_cursor_without_replaying(self):
        output = PlaybackBuffer(); output.start(1, 1)
        pcm = np.arange(480, dtype='<i2').tobytes()
        output.append(1, 1, 0, pcm); output.end(1, 1, 1)
        first = output.render()
        self.assertTrue(output.pause(1, 1, 1, now=10))
        self.assertEqual(output.take_pause_event(), ('playback-paused', 1, 1, 1, 1))
        self.assertFalse(output.render(now=10.5).any())
        self.assertIsNone(output.take_completed())
        self.assertTrue(output.resume(1, 1, 1))
        self.assertEqual(output.take_pause_event(), ('playback-resumed', 1, 1, 1, 1))
        actual = np.concatenate([first, output.render(), output.render()])
        np.testing.assert_array_equal(actual, np.arange(480) / 32768)
        output.render(); self.assertEqual(output.take_completed(), (1, 1, 3))

    def test_pause_deadline_cannot_be_extended_and_stale_resume_cannot_affect_new_pause(self):
        output = PlaybackBuffer(); output.start(1, 1); output.append(1, 1, 0, b'\x01\x02'*320); output.end(1, 1, 1)
        self.assertTrue(output.pause(1, 1, 1, now=10))
        self.assertFalse(output.pause(1, 1, 1, now=11))
        self.assertFalse(output.pause(1, 1, 2, now=11))
        self.assertTrue(output.render(now=11.5).any())
        self.assertEqual(output.take_pause_event()[0], 'playback-resumed')
        self.assertTrue(output.pause(1, 1, 2, now=12))
        self.assertFalse(output.resume(1, 1, 1))
        self.assertFalse(output.render(now=12.1).any())
        output.cancel(); self.assertFalse(output.resume(1, 1, 2))
        self.assertIsNone(output.take_pause_event())

    def test_pause_does_not_remove_the_queue_capacity_limit(self):
        output = PlaybackBuffer(capacity_frames=2); output.start(1, 1)
        output.pause(1, 1, 1, now=10)
        self.assertTrue(output.append(1, 1, 0, bytes(640)))
        self.assertFalse(output.append(1, 1, 1, bytes(320)))
        self.assertFalse(output.render(now=10.1).any())
        self.assertIsNone(output.take_pause_event())

    def test_exact_pcm_and_completion_after_final_submission(self):
        output = PlaybackBuffer()
        pcm = np.arange(320, dtype='<i2').tobytes()
        self.assertTrue(output.start(1, 1))
        self.assertTrue(output.append(1, 1, 0, pcm))
        self.assertTrue(output.end(1, 1, 1))
        actual = np.concatenate([output.render(), output.render()])
        np.testing.assert_array_equal(actual, np.arange(320) / 32768)
        self.assertIsNone(output.take_completed())
        self.assertFalse(output.render().any())
        self.assertEqual(output.take_completed(), (1, 1, 2))
        self.assertIsNone(output.take_completed())

    def test_cancel_and_new_generation_reject_late_audio(self):
        output = PlaybackBuffer()
        output.start(1, 1); output.append(1, 1, 0, b'\x01\x02'*160)
        output.cancel()
        self.assertFalse(output.render().any())
        self.assertFalse(output.start(1, 1))
        self.assertTrue(output.start(2, 1))
        self.assertFalse(output.append(1, 1, 1, bytes(320)))
        self.assertTrue(output.append(2, 1, 0, bytes(320)))

    def test_overflow_gap_and_truncated_pcm_discard_entire_clip(self):
        for sequence, pcm in [(1,bytes(320)),(0,bytes(321)),(0,bytes(960))]:
            output = PlaybackBuffer(capacity_frames=2)
            output.start(1, 1)
            self.assertFalse(output.append(1, 1, sequence, pcm))
            self.assertFalse(output.render().any())
            self.assertFalse(output.append(1, 1, 0, bytes(320)))

    def test_underrun_is_silence_and_does_not_complete_unfinished_stream(self):
        output = PlaybackBuffer(); output.start(1, 1)
        self.assertFalse(output.render().any())
        self.assertIsNone(output.take_completed())
        self.assertTrue(output.append(1, 1, 0, bytes(320)))
        self.assertFalse(output.render().any())
        self.assertTrue(output.end(1, 1, 1))
        output.render(); output.render(); self.assertEqual(output.take_completed(), (1, 1, 1))

    def test_stream_waits_for_ten_frames_before_first_output(self):
        output = PlaybackBuffer(); output.start(1, 1)
        self.assertTrue(output.append(1, 1, 0, b'\x01\x02'*160*9))
        self.assertFalse(output.render().any())
        self.assertEqual(output.rendered, 0)
        self.assertTrue(output.append(1, 1, 1, b'\x01\x02'*160))
        self.assertTrue(output.render().any())
        self.assertEqual(output.rendered, 1)

    def test_starvation_refills_once_and_preserves_cursor_and_end_of_stream_tail(self):
        output=PlaybackBuffer();output.start(1,1)
        source=np.arange(160*35,dtype='<i2')+1
        output.append(1,1,0,source[:160*10].tobytes())
        heard=[output.render() for _ in range(10)]
        self.assertFalse(output.render().any())
        output.append(1,1,1,source[160*10:160*19].tobytes())
        for _ in range(4):self.assertFalse(output.render().any())
        self.assertEqual(output.rendered,10)
        output.append(1,1,2,source[160*19:160*30].tobytes())
        heard.extend(output.render() for _ in range(20))
        output.append(1,1,3,source[160*30:].tobytes());output.end(1,1,4)
        heard.extend(output.render() for _ in range(5));output.render()
        np.testing.assert_array_equal(np.concatenate(heard),source.astype(np.float32)/32768)
        self.assertEqual(output.health()['underrunCount'],1);self.assertEqual(output.health()['underrunFrames'],5)
        self.assertEqual(output.take_completed(),(1,1,35))

    def test_pause_is_not_misreported_as_underrun_and_new_turn_resets_health(self):
        output=PlaybackBuffer();output.start(1,1);output.append(1,1,0,bytes(3200))
        output.render();output.pause(1,1,1,now=10)
        for _ in range(4):output.render(now=10.1)
        self.assertEqual(output.health()['pausedFrames'],4);self.assertEqual(output.health()['underrunFrames'],0)
        output.cancel();output.start(2,1);self.assertEqual(output.health()['pausedFrames'],0)


if __name__ == '__main__': unittest.main()
