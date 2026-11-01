import unittest
from worker_lifetime import WorkerLifetime, ParentHeartbeatLost


class LifetimeTests(unittest.TestCase):
    def test_experiment_expires(self):
        now = [0]
        lifetime = WorkerLifetime(seconds=5, clock=lambda: now[0])
        now[0] = 4.9
        self.assertTrue(lifetime.running())
        now[0] = 5
        self.assertFalse(lifetime.running())

    def test_continuous_requires_owner_and_lives_past_experiment(self):
        with self.assertRaises(ValueError):
            WorkerLifetime(continuous=True)
        now = [0]
        lifetime = WorkerLifetime(continuous=True, controlled=True, clock=lambda: now[0])
        for second in range(1, 601):
            now[0] = second
            lifetime.ping()
            self.assertTrue(lifetime.running())

    def test_parent_stall_exits_instead_of_retaining_microphone(self):
        now = [0]
        lifetime = WorkerLifetime(continuous=True, controlled=True, clock=lambda: now[0])
        now[0] = 4
        lifetime.ping()
        now[0] = 9.01
        with self.assertRaises(ParentHeartbeatLost):
            lifetime.running()


if __name__ == '__main__':
    unittest.main()
