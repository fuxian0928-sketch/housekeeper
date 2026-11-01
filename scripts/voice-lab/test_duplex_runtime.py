import unittest
import numpy as np
from duplex_runtime import DuplexQueue


class DuplexTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.queue = DuplexQueue(clock=lambda: self.now, capacity=2)
        self.pcm = np.zeros(160, np.float32)

    def test_overflow_creates_new_epoch_instead_of_splicing_old_audio(self):
        for _ in range(3):
            self.queue.push(0,self.pcm,self.pcm)
        self.assertEqual(self.queue.dropped,2)
        self.assertEqual(self.queue.pop()[0],1)
        self.assertIsNone(self.queue.pop())

    def test_expired_pair_drops_history(self):
        self.queue.push(0,self.pcm,self.pcm)
        self.now = 300
        self.assertIsNone(self.queue.pop())
        self.queue.push(300,self.pcm,self.pcm)
        self.assertEqual(self.queue.pop()[0],1)

    def test_device_fault_clears_both_capture_and_reference(self):
        self.queue.push(0,self.pcm,self.pcm)
        self.queue.push(0,self.pcm,self.pcm,device_fault=True)
        self.assertEqual(self.queue.pop()[0],1)
        self.assertEqual(self.queue.dropped,1)

    def test_reference_copied_before_output_buffer_reuse(self):
        self.queue.push(0,self.pcm,self.pcm)
        self.pcm[:] = 1
        pair = self.queue.pop()
        self.assertEqual(float(pair[2].sum()),0)
        self.assertEqual(float(pair[3].sum()),0)
        with self.assertRaises(ValueError):
            self.queue.push(0,np.zeros(480,np.float32),self.pcm)

    def test_capture_gap_resets_even_when_queue_was_already_drained(self):
        self.queue.push(0,self.pcm,self.pcm)
        self.queue.pop()
        self.now=10
        self.queue.push(10,self.pcm,self.pcm)
        self.assertEqual(self.queue.pop()[0],1)


if __name__ == '__main__':
    unittest.main()
