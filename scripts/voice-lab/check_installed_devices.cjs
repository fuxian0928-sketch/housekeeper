// Post-install check: verifies installed resources and enumerates WASAPI endpoints.
// Never opens streams, reads credentials or changes the selected voice engine.
const path = require('node:path');
const {verifyNativeVoiceBundle} = require('../../electron/native-voice-bundle.cjs');
const {listNativeVoiceDevices} = require('../../electron/native-voice-runtime-check.cjs');
async function checkInstalledDevices(application) {
  const bundle = await verifyNativeVoiceBundle(path.join(application, 'resources/native-voice'));
  const devices = await listNativeVoiceDevices({appRoot:bundle.workerRoot, python:bundle.python});
  return {resourcesVerified:true, resourceFiles:bundle.files,
    inputs:devices.inputs.length, outputs:devices.outputs.length,
    usableInputs:devices.inputs.filter(d=>d.available).length,
    usableOutputs:devices.outputs.filter(d=>d.available).length, audioStreamsOpened:false};
}
module.exports = {checkInstalledDevices};
if (require.main === module) {
  if (process.argv.length !== 3) throw Error('Usage: node check_installed_devices.cjs <installed application directory>');
  checkInstalledDevices(path.resolve(process.argv[2])).then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.error(error.message);process.exitCode=1;});
}
