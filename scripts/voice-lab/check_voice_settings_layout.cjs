const { chromium } = require(process.env.VOICE_TEST_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15000);
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.route('**/api/projects', route => route.fulfill({ json: [] }));
    await page.route('**/api/settings', async route => {
      const body = route.request().postDataJSON();
      await route.fulfill({ json: body });
    });
    await page.route('**/__voice-settings-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
<html><head><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/polish.css"><link rel="stylesheet" href="/src/workspace.css"><link rel="stylesheet" href="/src/features/companion/companion.css"><link rel="stylesheet" href="/src/glass.css"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const React=(await import('/node_modules/.vite/deps/react.js')).default;
const ReactDOM=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const {CompanionSettings}=await import('/src/features/companion/CompanionSettings.tsx');
let settings={model:'fixture-chat-model',speechServiceBaseUrl:'',speechRealtimeRecognitionModel:'',speechRealtimeSynthesisBaseUrl:'',speechRealtimeSynthesisModel:'',speechRealtimeVoice:''};
window.savedConnection=null;window.savedPurposes=[];
window.aiSecretary={companion:{
getConfig:async()=>({enabled:false,voiceEnabled:false,alwaysOnTop:true,appearance:'character',iconSize:64,characterHeight:240,opacity:1,motion:'reduced',launchAtStartup:false,idleHideMinutes:0,mockMode:true,nativeVoiceManaged:true,wakeWordEnabled:false}),
listVoices:async()=>[],voiceEngineStatus:async()=>({current:'native',requested:'native',available:true,locked:false,restartRequired:false}),
listNativeDevices:async()=>({inputs:[{name:'Test microphone',available:true}],outputs:[{name:'Test speaker',available:true}],selected:{inputName:'Test microphone',outputName:'Test speaker'}}),
voiceKeyStatus:async()=>({recognition:window.savedPurposes.includes('recognition')?'configured':'missing',synthesis:window.savedPurposes.includes('synthesis')?'configured':'missing'}),
saveVoiceKey:async(purpose)=>{window.savedPurposes.push(purpose);return window.aiSecretary.companion.voiceKeyStatus()},
updateConfig:async value=>value,setVoiceEnabled:async enabled=>({enabled,running:enabled}),show:()=>{},setState:()=>{}
}};
Object.defineProperty(navigator,'mediaDevices',{value:{enumerateDevices:async()=>[],addEventListener(){},removeEventListener(){}}});
function App(){const [value,setValue]=React.useState(settings);return React.createElement('div',{className:'app-frame settings-mode'},React.createElement('aside',{className:'rail'}),React.createElement('div',{className:'workspace'},React.createElement('main',{className:'main-surface'},React.createElement('div',{className:'settings-page surface-page'},React.createElement('header',{className:'page-header'},React.createElement('h1',null,'设置')),React.createElement('nav',{className:'subpage-nav'},React.createElement('button',{type:'button'},'桌面希微')),React.createElement('div',{className:'settings-form subpage-panel companion-settings-form'},React.createElement(CompanionSettings,{settings:value,onSettingsSaved:next=>{window.savedConnection=next;setValue({...value,...next})},onError:message=>{throw Error(message)}}))))))}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>` }));
    await page.goto('http://127.0.0.1:4348/__voice-settings-test');
    await page.getByRole('button', { name: /设备与状态/ }).click();
    await page.getByRole('checkbox', { name: '启用语音对话' }).waitFor();
    await page.mouse.move(1200, 850);
    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(250);
    const outerScroll = await page.evaluate(() => ({ y: scrollY, documentHeight: document.documentElement.scrollHeight, appHeight: document.querySelector('.app-frame').getBoundingClientRect().height, viewport: innerHeight, ancestors: ['.app-frame','.workspace','.main-surface','.settings-page','.settings-form','.companion-settings'].map(selector=>({selector,top:document.querySelector(selector).scrollTop,rectTop:document.querySelector(selector).getBoundingClientRect().top})) }));
    assert.ok(outerScroll.y === 0 && outerScroll.documentHeight <= outerScroll.viewport + 1 && Math.abs(outerScroll.appHeight - outerScroll.viewport) <= 1 && outerScroll.ancestors.every(item=>item.top===0), `desktop settings must fit the viewport without page scrolling: ${JSON.stringify(outerScroll)}`);
    if (process.env.VOICE_TEST_SCREENSHOT) await page.screenshot({ path: process.env.VOICE_TEST_SCREENSHOT });
    assert.equal(await page.evaluate(() => scrollY), 0, 'screenshot must not move the page');
    const before = await page.locator('.companion-settings-nav').boundingBox();
    const scroll = await page.locator('.companion-settings-detail').evaluate(element => { element.scrollTop = 600; return { top: element.scrollTop, scrollable: element.scrollHeight > element.clientHeight }; });
    const after = await page.locator('.companion-settings-nav').boundingBox();
    assert.ok(scroll.scrollable && scroll.top > 0, 'details must scroll');
    assert.ok(before && after && Math.abs(before.y - after.y) < 1, 'navigation must remain in place');
    await page.getByRole('button', { name: /唤醒与连续对话/ }).click();
    assert.equal(await page.locator('.companion-settings-detail').evaluate(element => element.scrollTop), 0, 'switching voice sections must reset detail scroll');
    await page.getByRole('button', { name: /对话模式/ }).click();
    assert.equal(await page.locator('.voice-settings-tabs').count(), 0, 'voice settings must not add a third level of navigation');
    await page.getByRole('button', { name: /设备与状态/ }).click();
    assert.equal(await page.locator('.companion-settings-nav .companion-nav-group').count(), 2);

    await page.setViewportSize({ width: 1781, height: 1119 });
    const largeDesktopScroll = await page.evaluate(() => ({ documentHeight: document.documentElement.scrollHeight, viewport: innerHeight }));
    assert.ok(largeDesktopScroll.documentHeight <= largeDesktopScroll.viewport + 1, `large desktop settings must not scroll the document: ${JSON.stringify(largeDesktopScroll)}`);
    const largeDetail = await page.locator('.companion-settings-detail').boundingBox();
    assert.ok(largeDetail && largeDetail.height >= 650 && largeDetail.width >= 700, `large desktop settings should give the main controls room: ${JSON.stringify(largeDetail)}`);

    await page.setViewportSize({ width: 820, height: 760 });
    if (process.env.VOICE_TEST_SCREENSHOT_NARROW) await page.screenshot({ path: process.env.VOICE_TEST_SCREENSHOT_NARROW, fullPage: true });
    const narrow = await page.locator('.companion-settings-detail').evaluate(element => ({ scrollable: element.scrollHeight > element.clientHeight, width: element.clientWidth }));
    assert.ok(narrow.scrollable && narrow.width > 0);
    const narrowGeometry = await page.evaluate(() => { const detail=document.querySelector('.companion-settings-detail').getBoundingClientRect(); const nav=document.querySelector('.companion-settings-nav').getBoundingClientRect(); const active=document.querySelector('.companion-settings-nav button[aria-pressed="true"]').getBoundingClientRect(); return { detailHeight:detail.height, activeVisible:active.left>=nav.left-1&&active.right<=nav.right+1 }; });
    assert.ok(narrowGeometry.detailHeight >= 300 && narrowGeometry.activeVisible, `narrow desktop settings must keep active navigation and enough content visible: ${JSON.stringify(narrowGeometry)}`);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileWidth = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(mobileWidth.documentWidth <= mobileWidth.viewport + 1, `mobile settings must not create horizontal page scroll: ${JSON.stringify(mobileWidth)}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.settings-page').evaluate(element => {
      element.innerHTML = `<header class="page-header"><h1>设置</h1></header><nav class="subpage-nav">模型连接</nav><form class="settings-form subpage-panel connection-form"><section class="settings-section single-setting-section connection-settings"><div class="settings-heading">模型连接</div><div class="connection-layout"><nav class="connection-nav">${'<button type="button"><span>连接类型</span></button>'.repeat(6)}</nav><div class="connection-detail">${'<div style="height:100px">服务地址<input value="test"></div>'.repeat(40)}</div></div></section></form>`;
    });
    const modelNavBefore = await page.locator('.connection-nav').boundingBox();
    const modelScroll = await page.locator('.connection-detail').evaluate(element => { element.scrollTop = 700; return element.scrollTop; });
    const modelNavAfter = await page.locator('.connection-nav').boundingBox();
    assert.ok(modelScroll > 0 && modelNavBefore && modelNavAfter && Math.abs(modelNavBefore.y - modelNavAfter.y) < 1, 'model navigation must remain in place');
    const modelOuterScroll = await page.evaluate(() => ({ documentHeight: document.documentElement.scrollHeight, viewport: innerHeight }));
    assert.ok(modelOuterScroll.documentHeight <= modelOuterScroll.viewport + 1, `model connection settings must not scroll the document: ${JSON.stringify(modelOuterScroll)}`);
    await page.setViewportSize({ width: 820, height: 760 });
    assert.ok(await page.locator('.connection-detail').evaluate(element => element.scrollHeight > element.clientHeight), 'model details must remain scrollable at narrow desktop widths');
    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ independentScroll: true, flatVoiceNavigation: true, narrowLayout: true, modelNavigationFixed: true }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
