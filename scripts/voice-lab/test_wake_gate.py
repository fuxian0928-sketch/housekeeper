import unittest
from wake_gate import WakeGate


class WakeGateTests(unittest.TestCase):
    def test_click_or_brief_noise_cannot_confirm_wake(self):
        gate = WakeGate()
        self.assertFalse(any(gate.update(i * .01, i < 3, False, True) for i in range(80)))

    def test_sustained_speech_confirms_wake_only_in_standby(self):
        gate = WakeGate()
        for i in range(7):
            self.assertFalse(gate.update(i * .01, True, False, True))
        self.assertTrue(gate.update(.07, True, False, True))
        self.assertFalse(gate.update(.08, True, False, False))
        self.assertFalse(gate.update(.09, True, False, True))

    def test_farewell_output_and_tail_are_ignored(self):
        gate = WakeGate()
        for i in range(95):
            self.assertFalse(gate.update(i * .01, True, i < 20, i >= 20))
        for i in range(7):
            self.assertFalse(gate.update(1.0 + i * .01, True, False, True))
        self.assertTrue(gate.update(1.07, True, False, True))


if __name__ == '__main__':
    unittest.main()
