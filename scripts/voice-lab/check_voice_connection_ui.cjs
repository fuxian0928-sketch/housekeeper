const { chromium } = require(process.env.VOICE_TEST_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => console.error('page error:', error.message));
    const original = 'https://dashscope.aliyuncs.com/api/v1';
    const serverSettings = { speechServiceBaseUrl: original, speechRealtimeRecognitionModel: 'qwen3-asr-flash-realtime', speechRealtimeSynthesisBaseUrl: original, speechRealtimeSynthesisModel: 'qwen3-tts-flash-realtime', speechRealtimeVoice: 'Cherry', speechRecognitionModel: 'qwen-audio-3.0-asr-flash', speechSynthesisModel: 'qwen-audio-3.0-tts-flash', speechVoice: 'longanhuan_v3.6', speechInstruction: '', hasApiKey: true };
    const patches = [];
    await page.route('**/api/settings', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: serverSettings });
      const body = route.request().postDataJSON();
      patches.push(body);
      Object.assign(serverSettings, body);
      return route.fulfill({ json: serverSettings });
    });
    await page.route('**/__voice-connection-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const React=(await import('/node_modules/.vite/deps/react.js')).default;
const ReactDOM=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const {VoiceConnectionSettings}=await import('/src/features/companion/VoiceConnectionSettings.tsx');
window.failKey=true;window.holds=[];
window.aiSecretary={companion:{voiceEngineStatus:async()=>({current:'native'}),voiceRuntimeStatus:async()=>({engine:'native',enabled:true,running:true,error:null}),voiceKeyStatus:async()=>({recognition:'configured',synthesis:'configured'}),voiceKeyRevisions:async()=>({recognition:'old-version',synthesis:'old-version'}),beginVoiceConnectionSave:async()=>{window.holds.push('begin');return 'hold-1'},endVoiceConnectionSave:async()=>{window.holds.push('end');return true},saveVoiceKey:async()=>{if(window.failKey)throw Error('fixture-key-failure');return {recognition:'configured',synthesis:'configured'}}}};
function App(){const [settings,setSettings]=React.useState(${JSON.stringify(serverSettings)});return React.createElement('form',{onSubmit:event=>{event.preventDefault();window.outerSubmit=true}},React.createElement(VoiceConnectionSettings,{purpose:'asr',settings,onSaved:setSettings,onOpenVoiceDevices:()=>{},onOpenChat:()=>{}}))}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>` }));
    await page.goto('http://127.0.0.1:4348/__voice-connection-test');
    await page.getByText('语音识别', { exact: true }).waitFor();
    await page.getByLabel('服务地址').fill('https://dashscope-intl.aliyuncs.com/api/v1');
    await page.getByLabel('本机 API Key').fill('replacement-key');
    await page.getByRole('button', { name: '保存当前连接' }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(serverSettings.speechServiceBaseUrl, original, 'failed key save must restore server parameters');
    assert.deepEqual(patches.map(item => item.speechServiceBaseUrl), ['https://dashscope-intl.aliyuncs.com/api/v1', original]);
    assert.ok(patches.every(item => !Object.keys(item).some(key => /key/i.test(key))), 'local key must not go to settings API');
    assert.deepEqual(await page.evaluate(() => window.holds), ['begin', 'end']);
    await page.evaluate(() => { window.failKey = false; });
    await page.getByLabel('本机 API Key').fill('');
    await page.getByLabel('识别模型').fill('qwen3-asr-flash-realtime-v2');
    await page.getByLabel('识别模型').press('Enter');
    await page.getByText('连接已保存。', { exact: false }).waitFor();
    assert.equal(serverSettings.speechRealtimeRecognitionModel, 'qwen3-asr-flash-realtime-v2');
    assert.equal(await page.evaluate(() => window.outerSubmit || false), false, 'Enter must save the voice profile only');
    console.log(JSON.stringify({ rollbackOnKeyFailure: true, secretStaysLocal: true, enterSavesCurrentConnection: true }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
