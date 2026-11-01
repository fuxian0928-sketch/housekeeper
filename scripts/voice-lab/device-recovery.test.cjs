const test = require('node:test'), assert = require('node:assert/strict');
const { createDeviceRecovery } = require('../../electron/voice-device-recovery.cjs');
function setup(restart = async () => {}) {
  const jobs = new Map(), statuses = []; let id = 0, enabled = true;
  const timers = { set(fn, delay) { jobs.set(++id, { fn, delay }); return id; }, clear(key) { jobs.delete(key); } };
  const recovery = createDeviceRecovery({ enabled: () => enabled, restart, onStatus: e => statuses.push(e), timers });
  return { recovery, jobs, statuses, disable() { enabled = false; }, async next() { const [key, job] = jobs.entries().next().value; jobs.delete(key); await job.fn(); return job.delay; } };
}
test('device retries stop at three failures and never expose provider errors', async () => {
  let starts = 0; const s = setup(async () => { starts++; throw Error('sensitive-device-path'); });
  s.recovery.fault(); s.recovery.fault(); assert.equal(s.jobs.size, 1);
  assert.equal(await s.next(), 500); assert.equal(await s.next(), 1500); assert.equal(await s.next(), 3000);
  assert.equal(starts, 3); assert.equal(s.jobs.size, 0);
  assert.equal(s.statuses.at(-1).code, 'VOICE_DEVICE_RECOVERY_EXHAUSTED');
  assert.ok(!JSON.stringify(s.statuses).includes('sensitive'));
});
test('a brief successful restart does not reset a crash loop; stable operation does', async () => {
  const s = setup(); s.recovery.fault(); await s.next();
  assert.equal(s.statuses.at(-1).type, 'recovered');
  s.recovery.fault(); assert.equal(await s.next(), 1500);
  assert.equal(await s.next(), 30000);
  s.recovery.fault(); assert.equal(await s.next(), 500); s.recovery.close();
});
test('disable and close prevent queued retries, including completion of an in-flight attempt', async () => {
  let resolve, starts = 0;
  const s = setup(() => { starts++; return new Promise(r => { resolve = r; }); });
  s.recovery.fault(); const pending = s.next(); s.recovery.fault();
  assert.equal(starts, 1); assert.equal(s.jobs.size, 0);
  s.recovery.close(); resolve(); await pending;
  assert.equal(s.jobs.size, 0); assert.ok(!s.statuses.some(x => x.type === 'recovered'));
  const disabled = setup(() => { throw Error('must not start'); });
  disabled.recovery.fault(); disabled.disable(); await disabled.next(); assert.equal(disabled.jobs.size, 0);
});
test('explicit cancellation permits a fresh bounded recovery without stale timers', async () => {
  const s = setup(); s.recovery.fault(); s.recovery.cancel(); assert.equal(s.jobs.size, 0);
  s.recovery.fault(); assert.equal(await s.next(), 500); s.recovery.close();
});

test('a fault during a restart cannot be masked by its late successful resolution', async () => {
 let resolve; const s = setup(() => new Promise(r => { resolve = r; }));
 s.recovery.fault(); const attempt = s.next(); s.recovery.fault(); resolve(); await attempt;
 assert.ok(!s.statuses.some(e => e.type === 'recovered'));
 assert.equal(s.jobs.size, 1); assert.equal([...s.jobs.values()][0].delay, 1500); s.recovery.close();
});
