const {defaultFarewellText,migrateLegacyIdentityDefaults}=require('./assistant-identity.cjs');
const DEFAULT_VOICE_FAREWELL = Object.freeze({voiceFarewellText:defaultFarewellText});
function validFarewell(value){return typeof value==='string' && value.trim().length>0 && value.length<=120 && !/[\x00-\x1f]/.test(value);}
function sanitizeVoiceFarewell(changes){return validFarewell(changes?.voiceFarewellText)?{voiceFarewellText:changes.voiceFarewellText.trim()}:{};}
function readVoiceFarewell(config){return {...DEFAULT_VOICE_FAREWELL,...sanitizeVoiceFarewell(migrateLegacyIdentityDefaults(config))};}
module.exports={DEFAULT_VOICE_FAREWELL,validFarewell,sanitizeVoiceFarewell,readVoiceFarewell};
