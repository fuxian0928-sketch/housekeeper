/** Choose a physical drawing buffer without changing the model's UV coordinate system. */
export function chooseRenderSize(
  width,
  height,
  dpr = 1,
  { maxSide = 4096, maxPixels = 3145728 } = {},
) {
  const positive = (v) => Number.isFinite(v) && v > 0;
  if (!positive(width) || !positive(height)) return null;
  const ratio = positive(dpr) ? dpr : 1;
  const scale = Math.min(
    ratio,
    maxSide / Math.max(width, height),
    Math.sqrt(maxPixels / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    dpr: ratio,
    cssWidth: width,
    cssHeight: height,
  };
}

/** Zoom the original mesh in the GPU, instead of scaling a previously rasterized element. */
export class PortraitCamera {
  constructor() {
    this.scale = 1;
    this.target = 1;
    this.last = null;
  }
  setZoom(value, { immediate = false } = {}) {
    this.target = value ? 2.4 : 1;
    if (immediate) this.scale = this.target;
  }
  tick(now) {
    const dt =
      this.last === null
        ? 1 / 60
        : Math.max(0, Math.min(100, now - this.last)) / 1000;
    this.last = now;
    this.scale += (this.target - this.scale) * (1 - Math.exp(-dt / 0.07));
    if (Math.abs(this.target - this.scale) < 0.0005) this.scale = this.target;
    return this.scale;
  }
  get active() {
    return this.scale !== this.target;
  }
  pause() {
    this.last = null;
  }
}
