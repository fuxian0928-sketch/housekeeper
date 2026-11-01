const identity = require('../assistant-identity.json');
const compactWake = value => value.replace(/\s/gu, '').toLowerCase();
const legacyDefaults = new Set(identity.legacyDefaultWakeWords.map(compactWake));
const builtInWords = new Set([...identity.defaultWakePhrases, ...identity.legacyWakePhrases].map(compactWake));

function isBuiltInWakeWord(value) {
 return typeof value === 'string' && builtInWords.has(compactWake(value));
}
function readWakeWord(config = {}) {
 const value = config.wakeWord;
 return value === undefined || typeof value === 'string' && legacyDefaults.has(compactWake(value)) ? identity.defaultWakeWord : value;
}
// Migrate only known defaults. Device bindings and user-authored preferences stay intact.
function migrateLegacyIdentityDefaults(config = {}) {
 const next = {...config};
 if (typeof next.wakeWord === 'string' && legacyDefaults.has(compactWake(next.wakeWord))) next.wakeWord = identity.defaultWakeWord;
 if (identity.legacyDefaultFarewellTexts.includes(next.voiceFarewellText)) next.voiceFarewellText = identity.defaultFarewellText;
 return next;
}

module.exports = {...identity, isBuiltInWakeWord, readWakeWord, migrateLegacyIdentityDefaults};
