// Exercise actual installed main/preload in an isolated, hidden Electron profile.
const {_electron} = require(process.env.VOICE_TEST_PLAYWRIGHT || 'playwright');
const path = require('node:path'), assert = require('node:assert/strict');
const application = process.env.VOICE_TEST_APPLICATION;
if (!application) throw Error('VOICE_TEST_APPLICATION required');
(async()=>{
  const env = {...process.env, VOICE_TEST_APPLICATION:path.resolve(application),
    VOICE_TEST_PROFILE:path.resolve('outputs/voice-lab/device-ipc-'+Date.now())};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),
    args:[path.resolve('scripts/voice-lab/engine_electron_harness.cjs')],env,timeout:60000});
  try {
    const page = await app.firstWindow({timeout:60000});
    await page.waitForFunction(()=>Boolean(window.aiSecretary?.companion?.listNativeDevices));
    const result = await page.evaluate(async()=>{
      const api=window.aiSecretary.companion, config=await api.getConfig();
      const devices=await api.listNativeDevices();
      return {inputs:devices.inputs.length,outputs:devices.outputs.length,
        enabled:config.enabled,mockMode:config.mockMode,wakeWordEnabled:config.wakeWordEnabled};
    });
    assert.equal(result.enabled,false);assert.equal(result.mockMode,true);assert.equal(result.wakeWordEnabled,false);
    console.log(JSON.stringify({installedIpcVerified:true,...result}));
  } finally {await app.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
