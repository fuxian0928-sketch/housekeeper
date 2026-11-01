// Bounded device recovery. Never retries a user turn, tool call or audio response.
function createDeviceRecovery({ enabled, restart, onStatus, delays = [500, 1500, 3000], stableMs = 30000, timers = { set: setTimeout, clear: clearTimeout } }) {
  let pending = null, stable = null, attempts = 0, inFlight = false, closed = false, epoch = 0, faultDuringAttempt = false;
  const clear = () => {
    if (pending !== null) timers.clear(pending);
    if (stable !== null) timers.clear(stable);
    pending = stable = null;
  };
  function fault() {
    if (stable !== null) { timers.clear(stable); stable = null; }
    if (closed || !enabled() || pending !== null) return;
    if (inFlight) { faultDuringAttempt = true; return; }
    if (attempts >= delays.length) { onStatus?.({ type: 'failed', code: 'VOICE_DEVICE_RECOVERY_EXHAUSTED' }); return; }
    const delay = delays[attempts++], ticket = epoch;
    onStatus?.({ type: 'recovering', attempt: attempts });
    pending = timers.set(async () => {
      pending = null;
      if (closed || ticket !== epoch || !enabled()) return;
      inFlight = true; faultDuringAttempt = false;
      let failed = false;
      try {
        await restart();
        failed = faultDuringAttempt;
        if (!failed && !closed && ticket === epoch && enabled()) {
          onStatus?.({ type: 'recovered' });
          stable = timers.set(() => { stable = null; attempts = 0; }, stableMs);
          stable?.unref?.();
        }
      } catch { failed = true; }
      finally { inFlight = false; }
      if (failed && ticket === epoch) fault();
    }, delay);
    pending?.unref?.();
  }
  return { fault, cancel() { epoch++; clear(); attempts = 0; }, close() { closed = true; epoch++; clear(); } };
}
module.exports = { createDeviceRecovery };
