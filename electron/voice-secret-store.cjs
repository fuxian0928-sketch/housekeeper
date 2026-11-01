const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
function createVoiceSecretStore(directory, safeStorage) {
  const file = purpose => {
    if (!['recognition', 'synthesis'].includes(purpose)) throw Error('VOICE_INVALID_KEY_PURPOSE');
    return path.join(directory, `voice-${purpose}-key.secure`);
  };
  function load(purpose) {
    const target = file(purpose);
    if (!fs.existsSync(target) || !safeStorage.isEncryptionAvailable()) return null;
    try { return safeStorage.decryptString(fs.readFileSync(target)).trim() || null; } catch { return null; }
  }
  return {
    load,
    status() { return Object.fromEntries(['recognition', 'synthesis'].map(p => [p, load(p) ? 'configured' : fs.existsSync(file(p)) ? 'unreadable' : 'missing'])); },
    revisions() { return Object.fromEntries(['recognition', 'synthesis'].map(p => {
      const target = file(p);
      return [p, fs.existsSync(target) ? createHash('sha256').update(fs.readFileSync(target)).digest('hex').slice(0, 24) : ''];
    })); },
    save(purpose, value) {
      const target = file(purpose);
      if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\r\n]/.test(value)) throw Error('VOICE_INVALID_KEY');
      if (!safeStorage.isEncryptionAvailable()) throw Error('VOICE_ENCRYPTION_UNAVAILABLE');
      const encrypted = safeStorage.encryptString(value.trim());
      fs.mkdirSync(directory, { recursive: true });
      const temporary = `${target}.tmp`;
      try { fs.writeFileSync(temporary, encrypted, { mode: 0o600 }); fs.renameSync(temporary, target); }
      finally { encrypted.fill(0); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return this.status();
    }
  };
}
module.exports = { createVoiceSecretStore };
