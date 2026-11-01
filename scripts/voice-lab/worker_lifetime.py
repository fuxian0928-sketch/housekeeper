"""Bounded experiment or supervised continuous worker; monotonic time only."""
import threading
import time


class ParentHeartbeatLost(RuntimeError):
    pass


class WorkerLifetime:
    def __init__(self, seconds=5, continuous=False, controlled=False, clock=time.perf_counter):
        if continuous and not controlled:
            raise ValueError('Continuous mode requires inherited control pipe')
        self.clock = clock
        self.continuous = continuous
        self.started = clock()
        self.seconds = seconds
        self.last_ping = self.started
        self.lock = threading.Lock()

    def ping(self):
        with self.lock:
            self.last_ping = self.clock()

    def running(self):
        now = self.clock()
        with self.lock:
            last_ping = self.last_ping
        if self.continuous and now - last_ping > 5:
            raise ParentHeartbeatLost('Parent heartbeat missing')
        return self.continuous or now - self.started < self.seconds
