// A bounded numeric envelope, aligned to the native device's rendered-frame
// receipts. No audio samples, text, keys or conversation content leave the host.
function createPortraitPlaybackMeter(worker, key, notify = () => {}) {
  let offered = 0, rendered = 0, stopped = false;
  const levels = [];
  const matches = event => ['generation','audioGeneration','turn'].every(field => event[field] === key[field]);
  const emit = value => {try {notify(Math.max(0, Math.min(1, value)));} catch { /* Visual observers cannot stop playback. */ }};
  function observe(event) {
    if (stopped || !matches(event)) return;
    if (['playback-paused','turn-cancelled','standby','playback-failed','playback-submitted'].includes(event.type)) {emit(0); return;}
    if (event.type !== 'playback-progress' || !Number.isSafeInteger(event.renderedFrames) || event.renderedFrames <= rendered || event.renderedFrames > offered) return;
    const end = event.renderedFrames;
    const recent = levels.filter(row => row.frame > Math.max(rendered, end - 10) && row.frame <= end);
    rendered = end;
    while (levels.length && levels[0].frame <= end) levels.shift();
    if (recent.length) emit(Math.sqrt(recent.reduce((sum, row) => sum + row.power, 0) / recent.length));
  }
  worker.on('event', observe);
  return {
    offer(pcm) {
      for (let offset = 0; offset + 320 <= pcm.length; offset += 320) {
        let power = 0;
        for (let index = offset; index < offset + 320; index += 2) power += (pcm.readInt16LE(index) / 32768) ** 2;
        levels.push({frame: ++offered, power: power / 160});
      }
      // Even an unresponsive device cannot grow this observer without bound.
      if (levels.length > 256) levels.splice(0, levels.length - 256);
    },
    dispose() {if (stopped) return; stopped = true; worker.off('event', observe); levels.length = 0; emit(0);}
  };
}
module.exports = {createPortraitPlaybackMeter};
