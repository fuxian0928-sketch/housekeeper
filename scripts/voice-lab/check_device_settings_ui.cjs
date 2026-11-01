const {chromium}=require(process.env.VOICE_TEST_PLAYWRIGHT || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>console.error(error.message));
  await page.route('**/__device-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const React=(await import('/node_modules/.vite/deps/react.js')).default;
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
const {CompanionSettings}=await import('/src/features/companion/CompanionSettings.tsx');
const {NativeVoiceDeviceSettings}=await import('/src/features/companion/NativeVoiceDeviceSettings.tsx');
const config={enabled:false,alwaysOnTop:true,appearance:'icon',iconSize:64,characterHeight:240,opacity:1,motion:'reduced',launchAtStartup:false,idleHideMinutes:0,mockMode:true};
let calls=0;
window.aiSecretary={companion:{getConfig:async()=>config,listVoices:async()=>{throw Error('System voice unavailable')},listNativeDevices:async()=>{if(++calls===1)throw Error('VOICE_NATIVE_BUNDLE_INVALID');return {inputs:[{name:'Fixture microphone',available:true}],outputs:[{name:'Fixture speaker',available:true}],selected:{inputName:'Fixture microphone',outputName:'Fixture speaker'}}}}};
Object.defineProperty(navigator,'mediaDevices',{value:{enumerateDevices:async()=>[{kind:'audioinput',deviceId:'mic',label:'Fixture microphone'},{kind:'videoinput',deviceId:'camera',label:'Fixture camera'}],addEventListener(){},removeEventListener(){}}});
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(CompanionSettings,{onError:()=>{}}),React.createElement(NativeVoiceDeviceSettings)));
</script>`}));
  await page.goto('http://127.0.0.1:4347/__device-test');
  await page.getByRole('button',{name:'摄像头与麦克风'}).click();
  await page.getByText('已发现 1 个输入设备').waitFor();
  await page.getByText('已发现 1 个视频设备').waitFor();
  await page.getByRole('alert').filter({hasText:'语音组件缺失或损坏'}).waitFor();
  await page.getByRole('button',{name:'刷新音频设备'}).click();
  await page.getByRole('button',{name:'保存并重新连接'}).waitFor();
  await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='保存并重新连接')?.disabled);
  assert.equal(await page.getByRole('alert').count(),0);
  console.log(JSON.stringify({voiceFailureDoesNotHideDevices:true,bundleRepairGuidance:true,refreshRecoversSelection:true}));
 } finally {await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1});
