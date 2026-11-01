// Only fixed diagnostic codes may cross the renderer boundary.
const codes = new Set([
  'VOICE_NATIVE_BUNDLE_INVALID', 'VOICE_NATIVE_RUNTIME_CHECK_FAILED',
  'VOICE_NATIVE_RUNTIME_CHECK_TIMEOUT', 'VOICE_NATIVE_PYTHON_VERSION',
  'VOICE_NATIVE_DEPENDENCY_VERSION', 'VOICE_NATIVE_DEPENDENCY_MISSING',
  'VOICE_NATIVE_DEPENDENCY_LOAD', 'VOICE_NATIVE_DEVICE_ENUMERATION',
  'VOICE_DEVICE_SELECTION_INVALID', 'VOICE_DEVICE_SELECTION_UNAVAILABLE'
]);
function voiceDeviceError(error) {
  return new Error(codes.has(error?.message) ? error.message : 'VOICE_NATIVE_RUNTIME_CHECK_FAILED');
}
module.exports = { voiceDeviceError };
