const clamp = (value, low = 0, high = 1) =>
  Math.min(high, Math.max(low, Number.isFinite(value) ? value : 0));
const ease = (value) =>
  value < 0.5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2;

export class HeadState {
  constructor() {
    this.phase = "idle";
    this.generation = 0;
    this.eye = 0;
    this.mouth = 0;
    this.manual = 0;
    this.blinkStart = null;
    this.pose = null;
    this.lastTime = null;
  }
  cancelPlayback() {
    this.generation++;
    this.mouth = 0;
    this.manual = 0;
    if (this.phase !== "asleep") this.phase = "idle";
    return this.generation;
  }
  preparePlayback() {
    this.cancelPlayback();
    if (this.phase === "asleep") return null;
    this.phase = "preparing";
    return this.generation;
  }
  playbackStarted(token) {
    if (token !== this.generation || this.phase === "asleep") return false;
    this.phase = "speaking";
    return true;
  }
  playbackEnded(token) {
    if (token !== this.generation) return false;
    this.cancelPlayback();
    return true;
  }
  setManual(value) {
    if (this.phase === "asleep") return;
    this.cancelPlayback();
    this.manual = clamp(value);
    this.mouth = this.manual;
  }
  blink(now) {
    if (this.phase === "asleep" || this.pose || this.blinkStart !== null)
      return false;
    this.blinkStart = now;
    return true;
  }
  sleep(now, reduced = false) {
    this.cancelPlayback();
    this.phase = "asleep";
    this.blinkStart = null;
    this.pose = {
      from: this.eye,
      to: 1,
      start: now,
      duration: reduced ? 0 : 280,
    };
  }
  wake(now, reduced = false) {
    this.phase = "idle";
    this.blinkStart = null;
    this.pose = {
      from: this.eye,
      to: 0,
      start: now,
      duration: reduced ? 0 : 340,
    };
  }
  tick(now, rms = 0) {
    const dt = this.lastTime === null ? 16 : clamp(now - this.lastTime, 0, 100);
    this.lastTime = now;
    if (this.pose) {
      const ratio = this.pose.duration
        ? clamp((now - this.pose.start) / this.pose.duration)
        : 1;
      this.eye = this.pose.from + (this.pose.to - this.pose.from) * ease(ratio);
      if (ratio === 1) this.pose = null;
    } else if (this.phase === "asleep") this.eye = 1;
    else if (this.blinkStart !== null) {
      const t = now - this.blinkStart;
      this.eye =
        t < 80
          ? ease(clamp(t / 80))
          : t < 115
            ? 1
            : t < 225
              ? 1 - ease(clamp((t - 115) / 110))
              : 0;
      if (t >= 225) this.blinkStart = null;
    } else this.eye = 0;
    if (this.phase === "speaking") {
      const target = clamp((rms - 0.009) / 0.1);
      const tau = target > this.mouth ? 28 : 72;
      this.mouth += (target - this.mouth) * (1 - Math.exp(-dt / tau));
      if (target === 0 && this.mouth < 0.005) this.mouth = 0;
    } else this.mouth = this.phase === "asleep" ? 0 : this.manual;
    return this.snapshot();
  }
  snapshot() {
    return {
      phase: this.phase,
      generation: this.generation,
      eye: this.eye,
      mouth: this.mouth,
      animating:
        !!this.pose || this.blinkStart !== null || this.phase === "speaking",
    };
  }
}

export function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) {
    const value = (sample - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}
