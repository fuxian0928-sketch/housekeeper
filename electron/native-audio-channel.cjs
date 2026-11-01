// Private inherited-pipe transport. Never forward these envelopes to renderer/logs.
class NativeAudioChannel {
  constructor(consume, clock = () => performance.now()) {
    this.consume = consume; this.clock = clock; this.pending = null; this.offset = null; this.syncedAt = 0;
  }
  ping(token) { this.pending = { token, at: this.clock() }; }
  synchronize(token, workerClockMs) {
    const pending = this.pending;
    if (!pending || token !== pending.token) return false;
    this.pending = null;
    const now = this.clock(), rtt = now - pending.at;
    if (!Number.isFinite(workerClockMs) || rtt < 0 || rtt > 150) return false;
    const candidate = (pending.at + now) / 2 - workerClockMs;
    // Midpoint synchronization has at most RTT/2 uncertainty under nonnegative delays.
    this.offset = candidate; this.syncedAt = now; return true;
  }
  receive(message, workerGeneration) {
    const now = this.clock();
    if (this.offset === null || now - this.syncedAt > 4000) throw new Error('AUDIO_CLOCK_UNAVAILABLE');
    const { generation, turn, sequence, capturedAtMs, pcm, pauseId } = message;
    if (pauseId !== undefined && (!Number.isSafeInteger(pauseId) || pauseId < 1)) throw new Error('INVALID_AUDIO_PACKET');
    if (![generation, turn].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(sequence) || sequence < 0 || !Number.isFinite(capturedAtMs)
      || typeof pcm !== 'string' || !/^[A-Za-z0-9+/]{427}=$/.test(pcm)) throw new Error('INVALID_AUDIO_PACKET');
    const data = Buffer.from(pcm, 'base64');
    if (data.length !== 320 || data.toString('base64') !== pcm) throw new Error('INVALID_AUDIO_PACKET');
    const key = `${workerGeneration}:${generation}:${turn}:${pauseId ?? ''}`;
    if (this.turnKey !== key) { this.turnKey = key; this.turnOffset = this.offset; }
    // Freeze mapping for one utterance to preserve sample order across new clock probes.
    // Conservative 75ms uncertainty allowance makes estimated captures no newer than reality.
    const mapped = capturedAtMs + this.turnOffset - 75;
    if (mapped > now + 10 || now - mapped > 1800) throw new Error('AUDIO_PACKET_EXPIRED');
    const accepted = this.consume({ workerGeneration, audioGeneration: generation, turn, ...(pauseId === undefined ? {} : { pauseId }), sequence, pcm: data, capturedAt: mapped });
    if (accepted === false) throw new Error('AUDIO_CONSUMER_REJECTED');
  }
}
module.exports = { NativeAudioChannel };
