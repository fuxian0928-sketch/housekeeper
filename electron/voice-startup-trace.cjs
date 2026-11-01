const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { saveJsonAtomically } = require('./atomic-json-store.cjs');

const phases = new Set(['settings', 'resources', 'runtime', 'wake', 'speech-models', 'audio-device']);
const statuses = new Set(['starting', 'ready', 'paused', 'failed']);
const validCode = value => typeof value === 'string' && /^(?:VOICE|WORKER|AUDIO|ASR)_[A-Z_]{1,80}$/.test(value);
function clean(row) {
  if (!row || typeof row.at !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(row.at) ||
      typeof row.attempt !== 'string' || !/^[a-f0-9-]{36}$/.test(row.attempt) || !phases.has(row.phase) ||
      !statuses.has(row.status) || !Number.isSafeInteger(row.elapsedMs) || row.elapsedMs < 0 || row.elapsedMs > 86400000) return null;
  return { at: row.at, attempt: row.attempt, phase: row.phase, status: row.status, elapsedMs: row.elapsedMs,
    ...(validCode(row.code) ? { code: row.code } : {}) };
}

// Startup failures precede conversation timing. Record fixed metadata only:
// never connection secrets, transcripts, audio, paths, or native stderr.
function createVoiceStartupTrace(file) {
  const attempt = randomUUID(), began = performance.now();
  let phase = 'settings', finished = false;
  function record(status, code) {
    try {
      let rows = [];
      if (fs.existsSync(file) && fs.statSync(file).size <= 200000) {
        try {
          const old = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (Array.isArray(old.events)) rows = old.events.map(clean).filter(Boolean).slice(-127);
        } catch { /* A corrupt old report must not hide the next failure. */ }
      }
      const row = clean({ at: new Date().toISOString(), attempt, phase, status,
        elapsedMs: Math.min(86400000, Math.round(performance.now() - began)), ...(code ? { code } : {}) });
      if (row) saveJsonAtomically(file, { schema: 1, events: [...rows, row] });
    } catch { /* Log failure must not disable voice or overwrite its real error. */ }
  }
  return {
    mark(next) { if (!finished && phases.has(next)) { phase = next; record('starting'); } },
    finish(status, code) { if (!finished && ['ready', 'paused', 'failed'].includes(status)) { finished = true; record(status, code); } }
  };
}
module.exports = { createVoiceStartupTrace };
