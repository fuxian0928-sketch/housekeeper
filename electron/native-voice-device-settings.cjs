const fs = require('node:fs');
const path = require('node:path');
function valid(value) { return value && ['inputName','outputName'].every(k => typeof value[k] === 'string' && value[k].trim() && value[k].length <= 200); }
function createNativeVoiceDeviceSettings({ dataDirectory, fallback, enumerate, apply, failure, systemDefaults = false }) {
  const file = path.join(dataDirectory, 'native-voice-devices.json');
  let serial = Promise.resolve();
  function read() {
    try { const value = JSON.parse(fs.readFileSync(file,'utf8')); if (valid(value) && (!systemDefaults || value.followSystemDefault === false)) return {inputName:value.inputName,outputName:value.outputName}; } catch {}
    if (systemDefaults) return {inputName:'__system_default__',outputName:'__system_default__'};
    const value = fallback(); return {inputName:value.inputName,outputName:value.outputName};
  }
  return { read, async list() { return {...await enumerate(),selected:read()}; }, save(value) {
    const snapshot = valid(value) ? {inputName:value.inputName,outputName:value.outputName,...(systemDefaults?{followSystemDefault:value.inputName==='__system_default__'&&value.outputName==='__system_default__'}:{})} : null;
    const task = serial.catch(()=>{}).then(async()=>{
      if (!snapshot) throw Error('VOICE_DEVICE_SELECTION_INVALID');
      const devices = await enumerate();
      if (!devices.inputs.some(d=>d.name===snapshot.inputName&&d.available) || !devices.outputs.some(d=>d.name===snapshot.outputName&&d.available)) throw Error('VOICE_DEVICE_SELECTION_UNAVAILABLE');
      fs.mkdirSync(dataDirectory,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(snapshot));fs.renameSync(file+'.tmp',file);
      // Saving is distinct from applying: retain selection if reconnect fails.
      let applied=false;try { applied=await apply() === true; } catch {}
      // Keep a successful save distinct from a failed reconnect, and preserve
      // the public startup message instead of blaming unrelated cloud keys.
      let error;
      if (!applied) { try { error = failure?.(); } catch {} }
      return {saved:true,applied,...(typeof error === 'string' && error.length > 0 && error.length <= 1000 ? {error} : {})};
    });serial=task;return task;
  }};
}
module.exports={createNativeVoiceDeviceSettings};
