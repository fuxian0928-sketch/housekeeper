const { spawn } = require('node:child_process');
const path = require('node:path');
const codes = new Set(['VOICE_NATIVE_DEVICE_MISSING', 'VOICE_NATIVE_DEVICE_AMBIGUOUS', 'VOICE_NATIVE_DEVICE_CHANNELS', 'VOICE_NATIVE_DEVICE_ENUMERATION', 'VOICE_NATIVE_PYTHON_VERSION', 'VOICE_NATIVE_DEPENDENCY_VERSION', 'VOICE_NATIVE_DEPENDENCY_MISSING', 'VOICE_NATIVE_DEPENDENCY_LOAD']);

// Internal process runner, not renderer IPC. stdout is a bounded fixed-schema report.
function runRuntimeProbe({ executable, args, cwd, timeoutMs = 10000, deviceList = false }) {
  return new Promise((resolve, reject) => {
    let child, timer, failure, output = '', bytes = 0, done = false;
    const fail = code => { failure ||= code; child?.kill(); };
    const finish = (code) => {
      if (done) return; done = true; clearTimeout(timer);
      if (failure) { reject(Error(failure)); return; }
      try {
        const value = JSON.parse(output);
        if (deviceList && code === 0 && value.ready === true) {
          const devices = {};
          for (const key of ['inputs', 'outputs']) {
            const rows = value.devices?.[key];
            if (!Array.isArray(rows) || rows.length > 128 || rows.some(row => typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 || typeof row.available !== 'boolean') || new Set(rows.map(row => row.name)).size !== rows.length) throw Error();
            devices[key] = rows.map(({name, available}) => ({name, available}));
          }
          resolve(devices); return;
        }
        if (!deviceList && code === 0 && value.ready === true && Object.keys(value).length === 1) { resolve({ ready: true }); return; }
        reject(Error(value.ready === false && codes.has(value.code) ? value.code : 'VOICE_NATIVE_RUNTIME_CHECK_FAILED'));
      } catch { reject(Error('VOICE_NATIVE_RUNTIME_CHECK_FAILED')); }
    };
    try { child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(Error('VOICE_NATIVE_RUNTIME_CHECK_FAILED')); return; }
    timer = setTimeout(() => fail('VOICE_NATIVE_RUNTIME_CHECK_TIMEOUT'), timeoutMs);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > (deviceList ? 131072 : 4096)) fail('VOICE_NATIVE_RUNTIME_CHECK_FAILED'); else output += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > (deviceList ? 131072 : 4096)) fail('VOICE_NATIVE_RUNTIME_CHECK_FAILED'); });
    child.on('error', () => { failure ||= 'VOICE_NATIVE_RUNTIME_CHECK_FAILED'; });
    child.on('close', finish);
  });
}
function verifyNativeVoiceRuntime({ appRoot, python, inputName, outputName }) {
  return runRuntimeProbe({ executable: python, args: ['-E', '-s', '-B', path.join(appRoot, 'scripts/voice-lab/runtime_probe.py'), ...(inputName !== undefined || outputName !== undefined ? ['--input-name', String(inputName ?? ''), '--output-name', String(outputName ?? '')] : [])], cwd: appRoot });
}
function listNativeVoiceDevices({appRoot, python}) {
  return runRuntimeProbe({executable:python,args:['-E','-s','-B',path.join(appRoot,'scripts/voice-lab/runtime_probe.py'),'--list-devices'],cwd:appRoot,deviceList:true});
}
module.exports = { verifyNativeVoiceRuntime, runRuntimeProbe, listNativeVoiceDevices };
