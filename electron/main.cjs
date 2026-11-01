const { DEFAULT_VOICE_PROCESSING, sanitizeVoiceProcessing, readVoiceProcessing } = require('./voice-processing-config.cjs');
const { DEFAULT_VOICE_FAREWELL, sanitizeVoiceFarewell, readVoiceFarewell } = require('./voice-farewell-config.cjs');
const { DEFAULT_VOICE_PREFETCH, sanitizeVoicePrefetch, readVoicePrefetch } = require('./voice-prefetch-config.cjs');
const { voiceStatusMessage, voiceStatusState } = require('./voice-status-message.cjs');
const { DEFAULT_VOICE_PROGRESS, sanitizeVoiceProgress, readVoiceProgress } = require('./voice-progress-config.cjs');
const { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, screen, session, shell, Tray } = require('electron');
const { DEFAULT_VOICE_SYNTHESIS, sanitizeVoiceSynthesis, readVoiceSynthesis } = require('./voice-synthesis-config.cjs');
const { DEFAULT_VOICE_TIMING, sanitizeVoiceTiming, readVoiceTiming } = require('./voice-timing-config.cjs');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {displayName,defaultWakeWord,migrateLegacyIdentityDefaults}=require('./assistant-identity.cjs');

const DEFAULT_APP_PORT = 43120;
let appPort = DEFAULT_APP_PORT;
const persistentDataDirectory = path.join(app.getPath('appData'), 'housekeeper');
const voiceClientId = require('./voice-client-id.cjs').readVoiceClientId(persistentDataDirectory);
// v0.4 uses a fresh Electron runtime profile so an orphaned mutex from the
// legacy desktop build cannot prevent startup. Business data and encrypted
// secrets intentionally remain in the established persistent data directory.
app.setPath('userData', path.join(app.getPath('appData'), 'housekeeper-runtime'));
let mainWindow = null;
let companionWindow = null;
let tray = null;
let isQuitting = false;
let localServiceReady = false;
let companionState = 'idle';
let updateInFlight = null;
let speechProcess = null;
// Explicit development overrides are separate from the persisted packaged choice.
const nativeVoiceConfigFile = !app.isPackaged ? process.env.AI_SECRETARY_NATIVE_VOICE_CONFIG : '';
const nativeVoiceBundleRoot = app.isPackaged ? path.join(process.resourcesPath, 'native-voice') : process.env.AI_SECRETARY_NATIVE_VOICE_BUNDLE || '';
const voiceEngineSelection = require('./voice-engine-selection.cjs').createVoiceEngineSelection({dataDirectory:persistentDataDirectory,bundleRoot:nativeVoiceBundleRoot,forcedNative:Boolean(nativeVoiceConfigFile),verifyBundle:require('./native-voice-bundle.cjs').verifyNativeVoiceBundle});
const nativeVoiceManaged = voiceEngineSelection.current === 'native';
const activeVoiceBundleRoot = nativeVoiceManaged && !nativeVoiceConfigFile ? nativeVoiceBundleRoot : '';
const nativeVoiceWorkerRoot = activeVoiceBundleRoot || app.getAppPath();
let nativeVoiceHost = null;
let nativeVoiceError = null;
let nativeVoiceStarting = null;
let computerBridgeHost=null;
let interactionFocus=null;
global.__AI_SECRETARY_DEVICE_CONTEXT__=()=>({deviceId:voiceClientId,interactionContext:{focus:interactionFocus},computerCaller:computerBridgeHost?.authorization()});
function localComputerHost(){
  if(!computerBridgeHost){
    if(!safeStorage.isEncryptionAvailable())throw Error('当前Windows无法安全保存本机控制身份。');
    const driver=require('./windows-mcp-client.cjs').createWindowsMcpClient();
    computerBridgeHost=require('./computer-bridge-host.cjs').createComputerBridgeHost({port:appPort,deviceId:voiceClientId,dataDirectory:persistentDataDirectory,driver,encrypt:value=>safeStorage.encryptString(value),decrypt:value=>safeStorage.decryptString(value)});
  }
  return computerBridgeHost;
}
function receiveNavigation(request){
  if(request.deviceId&&request.deviceId!==voiceClientId)return;
  showMainWindow('chat');
  const send=()=>mainWindow?.webContents.send('assistant:navigate',request);
  if(mainWindow?.webContents.isLoadingMainFrame())mainWindow.webContents.once('did-finish-load',send);else send();
}
const voiceSecrets = require('./voice-secret-store.cjs').createVoiceSecretStore(persistentDataDirectory, safeStorage);
let voiceConnectionHold = null;
const ownsSingleInstanceLock = app.requestSingleInstanceLock();

const voicePreferenceHistory = require('./voice-preference-history.cjs').createVoicePreferenceHistory(persistentDataDirectory);
const companionConfigPath = path.join(persistentDataDirectory, 'desktop-companion.json');
const defaultCompanionConfig = Object.freeze({
  enabled: false,
  voiceEnabled: false,
  alwaysOnTop: true,
  appearance: 'character',
  iconSize: 64,
  characterHeight: 240,
  opacity: 1,
  motion: 'full',
  launchAtStartup: false,
  ...DEFAULT_VOICE_PROCESSING, ...DEFAULT_VOICE_FAREWELL, ...DEFAULT_VOICE_SYNTHESIS, ...DEFAULT_VOICE_TIMING, ...DEFAULT_VOICE_PROGRESS, ...DEFAULT_VOICE_PREFETCH,
  idleHideMinutes: 0,
  mockMode: !nativeVoiceManaged,
  voiceName: 'Microsoft Yaoyao',
  speechRate: 0,
  speechVolume: 100,
  cameraContextEnabled: false,
  voiceChatModel: '',
  voiceReasoningEffort: 'follow',
  voiceRoutingMode: 'auto',
  voiceProjectId: '',
  visionModel: '',
  wakeWordEnabled: false,
  wakeWord: defaultWakeWord,
  wakeWordThreshold: 0.66
});

function readCompanionConfig() {
  try {
    const saved = migrateLegacyIdentityDefaults(JSON.parse(fs.readFileSync(companionConfigPath, 'utf8')));
    const { size: _legacyScale, ...current } = saved ?? {};
    current.voiceRoutingMode = ['life', 'work', 'auto'].includes(current.voiceRoutingMode) ? current.voiceRoutingMode : 'auto';
    // User approved the voice-first experience; migrate the old life-only default once.
    if(current.voiceFirstVersion!==1&&current.voiceRoutingMode==='life')current.voiceRoutingMode='auto';
    current.voiceFirstVersion=1;
    current.voiceProjectId = typeof current.voiceProjectId === 'string' ? current.voiceProjectId.slice(0, 160) : '';
    Object.assign(current,require('./companion-voice-update.cjs').restoredVoiceFlags(current,nativeVoiceManaged));
    // The old voiceChatModel default was never sent to either voice path.
    // Existing installations therefore continue to follow the chat model.
    current.voiceChatModel = current.voiceAnswerConfigured === true && typeof current.voiceChatModel === 'string' ? current.voiceChatModel.trim().slice(0, 160) : '';
    current.voiceReasoningEffort = current.voiceAnswerConfigured === true && ['follow', 'auto', 'low', 'medium', 'high'].includes(current.voiceReasoningEffort) ? current.voiceReasoningEffort : 'follow';
    return { ...defaultCompanionConfig, ...current, ...readVoiceProcessing(current), ...readVoiceFarewell(current), ...readVoiceSynthesis(current), ...readVoiceTiming(current), ...readVoiceProgress(current), ...readVoicePrefetch(current), appearance: current.appearance === 'icon' ? 'icon' : 'character', iconSize: Number.isFinite(current.iconSize) ? Math.min(96, Math.max(48, Math.round(current.iconSize))) : defaultCompanionConfig.iconSize, characterHeight: Number.isFinite(current.characterHeight) ? Math.min(300, Math.max(180, Math.round(current.characterHeight))) : defaultCompanionConfig.characterHeight, position: saved?.position };
  } catch {
    return { ...defaultCompanionConfig };
  }
}

function saveCompanionConfig(config) {
  require('./atomic-json-store.cjs').saveJsonAtomically(companionConfigPath,config);
}

function sanitizeCompanionChanges(changes) {
  const next = { ...sanitizeVoiceProcessing(changes), ...sanitizeVoiceFarewell(changes), ...sanitizeVoiceSynthesis(changes), ...sanitizeVoiceTiming(changes), ...sanitizeVoiceProgress(changes), ...sanitizeVoicePrefetch(changes) };
  if (typeof changes?.enabled === 'boolean') next.enabled = changes.enabled;
  if (typeof changes?.voiceEnabled === 'boolean') next.voiceEnabled = changes.voiceEnabled;
  if (typeof changes?.alwaysOnTop === 'boolean') next.alwaysOnTop = changes.alwaysOnTop;
  if (changes?.appearance === 'icon' || changes?.appearance === 'character') next.appearance = changes.appearance;
  if (Number.isFinite(changes?.iconSize)) next.iconSize = Math.min(96, Math.max(48, Math.round(Number(changes.iconSize))));
  if (Number.isFinite(changes?.characterHeight)) next.characterHeight = Math.min(300, Math.max(180, Math.round(Number(changes.characterHeight))));
  if (Number.isFinite(changes?.opacity)) next.opacity = Math.min(1, Math.max(.65, Number(changes.opacity)));
  if (changes?.motion === 'full' || changes?.motion === 'reduced') next.motion = changes.motion;
  if (typeof changes?.launchAtStartup === 'boolean') next.launchAtStartup = changes.launchAtStartup;
  if ([0, 15, 30, 60].includes(Number(changes?.idleHideMinutes))) next.idleHideMinutes = Number(changes.idleHideMinutes);
  if (typeof changes?.mockMode === 'boolean') next.mockMode = changes.mockMode;
  if (typeof changes?.microphoneDeviceId === 'string') next.microphoneDeviceId = changes.microphoneDeviceId.slice(0, 512);
  if (typeof changes?.cameraDeviceId === 'string') next.cameraDeviceId = changes.cameraDeviceId.slice(0, 512);
  if (typeof changes?.cameraFollowSystemDefault === 'boolean') next.cameraFollowSystemDefault = changes.cameraFollowSystemDefault;
  if (typeof changes?.voiceName === 'string') next.voiceName = changes.voiceName.slice(0, 160);
  if (Number.isFinite(changes?.speechRate)) next.speechRate = Math.min(5, Math.max(-5, Math.round(Number(changes.speechRate))));
  if (Number.isFinite(changes?.speechVolume)) next.speechVolume = Math.min(100, Math.max(0, Math.round(Number(changes.speechVolume))));
  if (typeof changes?.cameraContextEnabled === 'boolean') next.cameraContextEnabled = changes.cameraContextEnabled;
  if (typeof changes?.voiceChatModel === 'string') { next.voiceChatModel = changes.voiceChatModel.trim().slice(0, 160); next.voiceAnswerConfigured = true; }
  if (['follow', 'auto', 'low', 'medium', 'high'].includes(changes?.voiceReasoningEffort)) { next.voiceReasoningEffort = changes.voiceReasoningEffort; next.voiceAnswerConfigured = true; }
  if (['life', 'work', 'auto'].includes(changes?.voiceRoutingMode)) next.voiceRoutingMode = changes.voiceRoutingMode;
  if (typeof changes?.voiceProjectId === 'string') next.voiceProjectId = changes.voiceProjectId.trim().slice(0, 160);
  if (typeof changes?.visionModel === 'string') next.visionModel = changes.visionModel.slice(0, 160);
  if (typeof changes?.wakeWordEnabled === 'boolean') next.wakeWordEnabled = changes.wakeWordEnabled;
  if (typeof changes?.wakeWord === 'string' && changes.wakeWord.trim()) next.wakeWord = changes.wakeWord.trim().slice(0, 24);
  if (Number.isFinite(changes?.wakeWordThreshold)) next.wakeWordThreshold = Math.min(.95, Math.max(.45, Number(changes.wakeWordThreshold)));
  return next;
}

function speechScript(name) {
  return app.isPackaged ? path.join(process.resourcesPath, 'speech-scripts', name) : path.join(__dirname, 'scripts', name);
}

function runSpeechScript(name, args = [], stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', speechScript(name), ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    speechProcess = child;
    const output = [];
    const errors = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      if (speechProcess === child) speechProcess = null;
      const raw = Buffer.concat(output).toString('utf8').replace(/^\uFEFF/, '').trim();
      if (code !== 0 && !raw) return reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `本地语音进程退出：${code}`));
      try { resolve(raw ? JSON.parse(raw) : { ok: code === 0 }); }
      catch { reject(new Error(raw || Buffer.concat(errors).toString('utf8').trim() || '本地语音返回格式无效。')); }
    });
    if (stdin) child.stdin.end(stdin, 'utf8'); else child.stdin.end();
  });
}

function companionWindowSize(config) {
  if (config.appearance === 'character') return { width: Math.round(config.characterHeight * .56), height: config.characterHeight + 20 };
  const windowSize = config.iconSize + 20;
  return { width: windowSize, height: windowSize };
}

function emitCompanionState() {
  mainWindow?.webContents.send('companion:state-changed', companionState);
  companionWindow?.webContents.send('companion:state-changed', companionState);
}

function setCompanionState(nextState) {
  const supported = new Set(['idle', 'waking', 'listening', 'thinking', 'speaking', 'notifying', 'camera']);
  companionState = supported.has(nextState) ? nextState : 'idle';
  emitCompanionState();
  return companionState;
}

function showMainWindow(target = 'chat') {
  if (!mainWindow) createMainWindow();
  mainWindow?.show();
  mainWindow?.focus();
  if (target === 'settings') mainWindow?.webContents.send('companion:open-settings');
}

function buildCompanionMenu() {
  const config = readCompanionConfig();
  return Menu.buildFromTemplate([
    { label: companionWindow?.isVisible() ? '隐藏希微' : '显示希微', click: () => companionWindow?.isVisible() ? companionWindow.hide() : showCompanionWindow() },
    { label: '打开希微', click: () => showMainWindow('chat') },
    { label: '桌面希微设置', click: () => showMainWindow('settings') },
    { type: 'separator' },
    { label: '手动开始语音', enabled: config.voiceEnabled !== false && !config.mockMode, click: () => {
      if (nativeVoiceManaged) nativeVoiceHost?.control('wake');
      else {
        const win = showCompanionWindow();
        if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => win.webContents.send('companion:manual-wake'));
        else win.webContents.send('companion:manual-wake');
      }
    } },
    { label: '状态模拟', enabled: config.mockMode, submenu: [
      ['idle', '待机'], ['listening', '聆听'], ['thinking', '思考'], ['speaking', '说话'], ['notifying', '提醒'], ['camera', '视觉']
    ].map(([state, label]) => ({ label, type: 'radio', checked: companionState === state, click: () => setCompanionState(state) })) },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]);
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
  tray.setToolTip('希微 · AI 秘书');
  tray.on('click', () => companionWindow?.isVisible() ? companionWindow.hide() : showCompanionWindow());
  tray.on('right-click', () => tray?.popUpContextMenu(buildCompanionMenu()));
}

function resolvedCompanionPosition(config, bounds) {
  const candidate = config.position;
  if (candidate && Number.isFinite(candidate.x) && Number.isFinite(candidate.y)) {
    const display = screen.getDisplayMatching({ x: candidate.x, y: candidate.y, width: bounds.width, height: bounds.height });
    const area = display.workArea;
    return {
      x: Math.min(area.x + area.width - bounds.width, Math.max(area.x, Math.round(candidate.x))),
      y: Math.min(area.y + area.height - bounds.height, Math.max(area.y, Math.round(candidate.y)))
    };
  }
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - bounds.width - 24, y: area.y + area.height - bounds.height - 24 };
}

function createCompanionWindow() {
  if (companionWindow) return companionWindow;
  const config = readCompanionConfig();
  const bounds = companionWindowSize(config);
  const position = resolvedCompanionPosition(config, bounds);
  companionWindow = new BrowserWindow({
    ...bounds,
    ...position,
    minWidth: 68,
    minHeight: 68,
    maxWidth: 180,
    maxHeight: 320,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop,
    backgroundColor: '#00000000',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  companionWindow.setMenu(null);
  companionWindow.setOpacity(config.opacity);
  if (config.alwaysOnTop) companionWindow.setAlwaysOnTop(true, 'floating');
  companionWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  companionWindow.webContents.on('console-message', (_event, details, legacyMessage) => {
    const message = typeof details === 'object' ? details.message : legacyMessage;
    const match = typeof message === 'string' && message.match(/^\[voice-(timing|error|trace)\] (.*)$/);
    if (!match) return;
    try {
      const value = JSON.parse(match[2]);
      const record = { at: new Date().toISOString(), kind: match[1], stage: String(value.stage || '').replace(/[^a-z-]/g, '').slice(0, 48), ms: Number.isFinite(value.ms) ? value.ms : undefined, code: String(value.code || '').replace(/[^A-Za-z]/g, '').slice(0, 32) };
      if (match[1] === 'trace') {
        if (value.schema !== 1 || !/^[0-9a-f-]{36}$/i.test(value.sessionId) || !/^[0-9a-f-]{36}$/i.test(value.turnId) || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return;
        Object.assign(record, { schema: 1, sessionId: value.sessionId, turnId: value.turnId, sequence: value.sequence });
      }
      const directory = path.join(persistentDataDirectory, 'logs');
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, 'voice.jsonl');
      if (fs.existsSync(target) && fs.statSync(target).size > 2_000_000) fs.writeFileSync(target, '');
      fs.appendFileSync(target, JSON.stringify(record) + '\n');
    } catch { /* Never let diagnostic IO interrupt speech. */ }
  });
  companionWindow.once('ready-to-show', () => { if (readCompanionConfig().enabled) companionWindow?.showInactive(); });
  let positionSaveTimer = null;
  companionWindow.on('moved', () => {
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(() => {
      if (!companionWindow) return;
      const [x, y] = companionWindow.getPosition();
      const current = readCompanionConfig();
      saveCompanionConfig({ ...current, position: { x, y, displayId: String(screen.getDisplayMatching(companionWindow.getBounds()).id) } });
    }, 250);
  });
  companionWindow.on('closed', () => { companionWindow = null; });
  void companionWindow.loadURL(`http://127.0.0.1:${appPort}/?surface=companion`);
  return companionWindow;
}

function showCompanionWindow() {
  const win = createCompanionWindow();
  win.showInactive();
  return win;
}

function applyCompanionConfig(changes, { reconcile = true } = {}) {
  if (nativeVoiceManaged) require('./native-voice-settings-validation.cjs').validateNativeVoiceChanges(changes);
  const config = { ...readCompanionConfig(), ...sanitizeCompanionChanges(changes) };
  Object.assign(config, require('./companion-voice-update.cjs').restoredVoiceFlags(config,nativeVoiceManaged));
  if (nativeVoiceManaged) {
    try { require('./native-wake-keywords.cjs').wakeDefinition(config); }
    catch { throw Error('唤醒词未保存：请使用2–12个汉字或字母E。'); }
    voicePreferenceHistory.beforeSave(readCompanionConfig(),config);
  }
  saveCompanionConfig(config);
  if(nativeVoiceManaged&&(config.voiceEnabled===false||config.mockMode))setCompanionState('idle');
  app.setLoginItemSettings({ openAtLogin: config.launchAtStartup, openAsHidden: false });
  if (companionWindow) {
    const bounds = companionWindowSize(config);
    const position = resolvedCompanionPosition(config, bounds);
    companionWindow.setBounds({ ...position, ...bounds });
    companionWindow.setOpacity(config.opacity);
    companionWindow.setAlwaysOnTop(config.alwaysOnTop, config.alwaysOnTop ? 'floating' : 'normal');
    companionWindow.webContents.send('companion:config-changed', { ...config, nativeVoiceManaged, nativeVoiceError, deviceId: voiceClientId });
    if (config.enabled) companionWindow.showInactive(); else companionWindow.hide();
  } else if (config.enabled && app.isReady()) {
    showCompanionWindow();
  }
  if (reconcile && nativeVoiceHost) void nativeVoiceHost.reconcile().catch(() => setCompanionState('idle'));
  mainWindow?.webContents.send('companion:config-changed', { ...config, nativeVoiceManaged, nativeVoiceError, deviceId: voiceClientId });
  return { ...config, nativeVoiceManaged, nativeVoiceError, deviceId: voiceClientId };
}

ipcMain.handle('companion:get-config', () => ({ ...readCompanionConfig(), nativeVoiceManaged, nativeVoiceError, nativeVoiceStarting:Boolean(nativeVoiceStarting), deviceId: voiceClientId }));
function assertVoiceSettingsSender(event) {
  const reason = require('./voice-settings-sender.cjs').voiceSettingsSenderFailure(event, mainWindow, appPort);
  if (reason) {
    // Keep the diagnostic local. It contains no settings values, URLs, or keys.
    try { fs.appendFileSync(path.join(persistentDataDirectory, 'voice-settings-denials.log'), `${new Date().toISOString()} ${reason} sender=${Number.isSafeInteger(event?.sender?.id) ? event.sender.id : '-'} main=${Number.isSafeInteger(mainWindow?.webContents?.id) ? mainWindow.webContents.id : '-'} frame=${Number.isSafeInteger(event?.senderFrame?.frameTreeNodeId) ? event.senderFrame.frameTreeNodeId : '-'} mainFrame=${Number.isSafeInteger(mainWindow?.webContents?.mainFrame?.frameTreeNodeId) ? mainWindow.webContents.mainFrame.frameTreeNodeId : '-'}\n`); } catch {}
    throw Error('VOICE_SETTINGS_NOT_ALLOWED');
  }
}
ipcMain.handle('companion:native-control', require('./native-voice-control.cjs').createNativeVoiceControlHandler({
  windows:()=>[mainWindow,companionWindow],port:()=>appPort,host:()=>nativeVoiceHost
}));
const cameraFrames=require('./camera-frame-bridge.cjs').createCameraFrameBridge({ipcMain,window:()=>createCompanionWindow(),enabled:()=>readCompanionConfig().cameraContextEnabled===true,port:()=>appPort});
ipcMain.handle('companion:request-camera-frame',async(event,question)=>{
  assertVoiceSettingsSender(event);
  if(typeof question!=='string'||question.length>20000)return null;
  const {wantsCameraObservation}=await import(pathToFileURL(path.join(app.getAppPath(),'build/server/domain/interaction/vision-request.js')).href);
  return wantsCameraObservation(question)?cameraFrames.capture():null;
});
const nativeVoiceDevices = (nativeVoiceConfigFile || nativeVoiceBundleRoot) ? require('./native-voice-device-settings.cjs').createNativeVoiceDeviceSettings({
  dataDirectory:persistentDataDirectory,
  systemDefaults:true,
  failure:()=>nativeVoiceError || (readCompanionConfig().mockMode ? '语音设备已保存，请先关闭设备模拟再启用语音。' : '语音设备已保存，请先启用语音后重新连接。'),
  fallback:()=>nativeVoiceConfigFile ? JSON.parse(fs.readFileSync(nativeVoiceConfigFile,'utf8')) : {inputName:'',outputName:''},
  enumerate:async()=>{
    const bundle=!nativeVoiceConfigFile ? await require('./native-voice-bundle.cjs').verifyNativeVoiceBundle(nativeVoiceBundleRoot) : null;
    return require('./native-voice-runtime-check.cjs').listNativeVoiceDevices({appRoot:bundle?.workerRoot || nativeVoiceWorkerRoot,python:bundle?.python || JSON.parse(fs.readFileSync(nativeVoiceConfigFile,'utf8')).python});
  },
  async apply() {
    await nativeVoiceStarting;
    if(isQuitting)return false;
    const old=nativeVoiceHost;nativeVoiceHost=null;
    nativeVoiceStarting=(async()=>{await old?.close();if(!isQuitting)await initializeNativeVoiceHost();})().finally(()=>{nativeVoiceStarting=null;publishNativeVoiceStatus();});
    await nativeVoiceStarting;
    const config=readCompanionConfig();
    return Boolean(nativeVoiceHost&&!nativeVoiceError&&config.voiceEnabled&&!config.mockMode);
  }
}) : null;
ipcMain.handle('companion:list-native-devices',async event=>{assertVoiceSettingsSender(event);if(!nativeVoiceDevices)throw Error('原生语音尚未启用。');try{return await nativeVoiceDevices.list();}catch(error){throw require('./voice-device-error.cjs').voiceDeviceError(error);}});
ipcMain.handle('companion:save-native-devices',async(event,value)=>{assertVoiceSettingsSender(event);if(!nativeVoiceDevices)throw Error('原生语音尚未启用。');try{return await nativeVoiceDevices.save(value);}catch(error){throw require('./voice-device-error.cjs').voiceDeviceError(error);}});
ipcMain.handle('companion:voice-engine-status',event=>{assertVoiceSettingsSender(event);return voiceEngineSelection.inspect();});
ipcMain.handle('companion:save-voice-engine',async(event,engine)=>{assertVoiceSettingsSender(event);try{return await voiceEngineSelection.save(engine)}catch(error){throw Error(require('./voice-engine-selection.cjs').voiceEngineSelectionError(error))}});
ipcMain.handle('companion:restart-for-voice-engine',async event=>{
  assertVoiceSettingsSender(event);
  if (!voiceEngineSelection.status().restartRequired || isQuitting) return false;
  if (voiceEngineSelection.status().requested === 'native') {
    const devices = await nativeVoiceDevices?.list();
    if (!devices || !devices.inputs.some(device => device.available && device.name === devices.selected.inputName) || !devices.outputs.some(device => device.available && device.name === devices.selected.outputName)) throw Error('请先在设备与状态中选择可用的麦克风和扬声器。');
    const response = await fetch(`http://127.0.0.1:${appPort}/api/settings`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw Error('暂时无法检查语音模型连接，请确认服务器可用后重试。');
    const settings = await response.json();
    require('./companion-voice-update.cjs').assertNativeVoiceConnectionReady(settings, () => voiceSecrets.status());
  }
  // Register relaunch only after preflight succeeds. Window close normally
  // hides this tray application, so the explicit quit below is required.
  try { app.relaunch(); }
  catch { throw Error('客户端重启未能启动，请从托盘菜单退出后重新打开。'); }
  isQuitting = true;
  setImmediate(() => app.quit());
  return true;
});
ipcMain.handle('companion:voice-preference-history',event=>{assertVoiceSettingsSender(event);return voicePreferenceHistory.list();});
ipcMain.handle('companion:voice-preference-version',(event,id)=>{assertVoiceSettingsSender(event);return voicePreferenceHistory.get(id);});
ipcMain.handle('companion:default-voice-preferences',event=>{assertVoiceSettingsSender(event);return require('./voice-preference-transfer.cjs').defaultPreferences();});
ipcMain.handle('companion:export-voice-preferences',event=>{assertVoiceSettingsSender(event);return require('./voice-preference-transfer.cjs').exportPreferences(readCompanionConfig());});
ipcMain.handle('companion:preview-voice-preferences',(event,text)=>{assertVoiceSettingsSender(event);return require('./voice-preference-transfer.cjs').previewPreferences(text);});
ipcMain.handle('companion:import-voice-preferences',(event,text)=>{assertVoiceSettingsSender(event);if(!nativeVoiceManaged)throw Error('请先切换到原生语音，再导入偏好。');return applyCompanionConfig(require('./voice-preference-transfer.cjs').parsePreferences(text));});
ipcMain.handle('companion:preview-native-voice',event=>{assertVoiceSettingsSender(event);return nativeVoiceHost?.control('preview') ?? false;});
ipcMain.handle('companion:clear-voice-latency',async event=>{assertVoiceSettingsSender(event);if(!nativeVoiceHost)throw Error('原生语音尚未就绪，暂时无法清除耗时记录。');await nativeVoiceHost.clearTiming();return {available:true,turns:require('./voice-latency-report.cjs').voiceLatencyReport(nativeVoiceHost.timingStatus())};});
ipcMain.handle('companion:voice-latency',event=>{assertVoiceSettingsSender(event);return {available:Boolean(nativeVoiceHost),turns:require('./voice-latency-report.cjs').voiceLatencyReport(nativeVoiceHost?.timingStatus() ?? [])};});
ipcMain.handle('companion:voice-key-status', event => { assertVoiceSettingsSender(event); return voiceSecrets.status(); });
ipcMain.handle('companion:voice-key-revisions', event => { assertVoiceSettingsSender(event); return voiceSecrets.revisions(); });
ipcMain.handle('companion:begin-voice-connection-save', async event => {
  assertVoiceSettingsSender(event);
  if (!nativeVoiceManaged) return null;
  if (voiceConnectionHold) throw Error('另一项语音连接正在保存，请稍后重试。');
  if (nativeVoiceStarting) await nativeVoiceStarting;
  const token = randomUUID();
  // Every turn opened during the two-store update reads the last complete
  // parameter/credential pair. The renderer releases this hold in finally.
  const timer = setTimeout(() => {
    if (voiceConnectionHold?.token !== token) return;
    // A renderer may close midway through the two-store save. Stop listening
    // rather than silently resume with a potentially incomplete pair.
    nativeVoiceError = '语音连接保存超时，语音已暂停；请核对连接后重新开启。';
    applyCompanionConfig({ voiceEnabled: false }, { reconcile: false });
    void nativeVoiceHost?.reconcile().catch(() => undefined);
    voiceConnectionHold = null;
  }, 90_000);
  timer.unref?.();
  voiceConnectionHold = { token, senderId: event.sender.id, snapshot: nativeVoiceHost?.connectionSnapshot() ?? null, timer };
  return token;
});
ipcMain.handle('companion:end-voice-connection-save', async (event, token) => {
  assertVoiceSettingsSender(event);
  if (!voiceConnectionHold || voiceConnectionHold.token !== token || voiceConnectionHold.senderId !== event.sender.id) throw Error('语音连接保存状态已失效。');
  clearTimeout(voiceConnectionHold.timer);
  const previousLocation = voiceConnectionHold.snapshot?.settings?.speechExecution ?? 'cloud';
  voiceConnectionHold = null;
  if (nativeVoiceManaged) {
    const {SettingsService} = await import(pathToFileURL(path.join(app.getAppPath(), 'build/server/domain/settings/settings-service.js')).href);
    const nextLocation = new SettingsService().nativeVoiceConnection().speechExecution ?? 'cloud';
    if (nextLocation !== previousLocation) {
      const previous = nativeVoiceHost; nativeVoiceHost = null;
      await previous?.close();
      await startNativeVoiceHost();
    }
  }
  return true;
});
ipcMain.handle('companion:voice-runtime-status', event => {
  assertVoiceSettingsSender(event);
  const config = readCompanionConfig();
  return { engine: voiceEngineSelection.current, enabled: config.voiceEnabled !== false, starting:Boolean(nativeVoiceStarting), running: nativeVoiceManaged ? Boolean(nativeVoiceHost?.status().running) : null, error: nativeVoiceError || null };
});
ipcMain.handle('companion:test-native-voice-connection', async (event, draft) => {
  assertVoiceSettingsSender(event);
  if (!draft || !['recognition', 'synthesis'].includes(draft.purpose) || typeof draft.url !== 'string' || typeof draft.model !== 'string' || draft.url.length > 500 || draft.model.length > 160 || typeof draft.key !== 'string' || draft.key.length > 4096 || typeof draft.voice !== 'string' || draft.voice.length > 160) throw Error('语音连接草稿不完整。');
  const apiKey = draft.key.trim() || voiceSecrets.load(draft.purpose);
  if (!apiKey) throw Error('当前电脑缺少这项语音服务的密钥。');
  const provider = await import(pathToFileURL(path.join(app.getAppPath(), 'build/server/providers', draft.purpose === 'recognition' ? 'qwen-realtime-asr.js' : 'qwen-realtime-tts.js')).href);
  const signal = AbortSignal.timeout(10_000);
  const session = draft.purpose === 'recognition'
    ? provider.createQwenRealtimeAsr({ baseUrl: draft.url.trim(), model: draft.model.trim(), apiKey, signal })
    : provider.createQwenRealtimeTts({ baseUrl: draft.url.trim(), model: draft.model.trim(), voice: draft.voice.trim(), apiKey, signal });
  try {
    await session.ready;
    return { connected: true, stage: 'authenticated-session', detail: '草稿已通过实时服务认证握手；尚未验证录音转写或扬声器听音。' };
  } finally { session.cancel(); }
});
ipcMain.handle('companion:set-voice-enabled', async (event, enabled) => {
  assertVoiceSettingsSender(event);
  if (typeof enabled !== 'boolean') throw Error('语音开关值无效。');
  if (enabled && voiceConnectionHold) throw Error('语音连接正在保存，完成后再开启语音。');
  const previousConfig = readCompanionConfig();
  if (enabled && nativeVoiceManaged) {
    const {SettingsService}=await import(pathToFileURL(path.join(app.getAppPath(),'build/server/domain/settings/settings-service.js')).href);
    if(require('./companion-voice-update.cjs').needsCloudVoiceKeys(new SettingsService().nativeVoiceConnection())){
      const status=voiceSecrets.status();
      if(status.recognition!=='configured'||status.synthesis!=='configured')throw Error('请先在模型连接中配置当前电脑的语音识别和合成密钥。');
    }
    const devices = await nativeVoiceDevices?.list();
    if (!devices || !devices.inputs.some(device => device.available && device.name === devices.selected.inputName) || !devices.outputs.some(device => device.available && device.name === devices.selected.outputName)) throw Error('选中的麦克风或扬声器不可用，请先在设备与状态中重新选择。');
  }
  applyCompanionConfig({ voiceEnabled: enabled, ...(enabled && nativeVoiceManaged ? { mockMode: false } : {}) }, { reconcile: false });
  if(!enabled)voiceStartupRestore.cancel();
  try {
    if (nativeVoiceManaged && enabled && !nativeVoiceHost) await startNativeVoiceHost();
    if (nativeVoiceManaged) {
      await nativeVoiceHost?.reconcile();
      if (enabled && !nativeVoiceHost?.status().running) throw Error(nativeVoiceError || '语音进程未能启动。');
      if (enabled) nativeVoiceError = null;
    }
    publishNativeVoiceStatus();
    const currentConfig=readCompanionConfig();
    return { enabled: currentConfig.voiceEnabled, mockMode:currentConfig.mockMode, running: nativeVoiceManaged ? Boolean(nativeVoiceHost?.status().running) : Boolean(enabled && !currentConfig.mockMode && currentConfig.enabled) };
  } catch (error) {
    applyCompanionConfig({ voiceEnabled: previousConfig.voiceEnabled, mockMode: previousConfig.mockMode }, { reconcile: false });
    await nativeVoiceHost?.reconcile().catch(() => undefined);
    throw error;
  }
});
ipcMain.handle('companion:save-voice-key', async (event, purpose, value) => {
  assertVoiceSettingsSender(event);
  // Persisting a credential is separate from enabling voice. Starting the
  // host here could fail after the key was written and misreport the save.
  return voiceSecrets.save(purpose, value);
});
ipcMain.handle('companion:update-config', async (event, changes) => {
  assertVoiceSettingsSender(event);
  changes=require('./companion-voice-update.cjs').nativeCompanionSettingsChanges(changes,nativeVoiceManaged);
  const before = readCompanionConfig();
  const reconnectFields = ['wakeWord', 'wakeWordThreshold', 'wakeWordEnabled', 'voiceNoiseSuppression', 'voiceAutoGain', 'voiceEchoDelayMs'];
  const reconnect = nativeVoiceManaged && reconnectFields.some(field => changes?.[field] !== undefined && changes[field] !== before[field]);
  const next = applyCompanionConfig(changes, { reconcile: false });
  if (!require('./companion-voice-update.cjs').requiresVoiceReconcile(before, next)) return next;
  if (!reconnect) {
    try { await nativeVoiceHost?.reconcile(); return next; }
    catch (error) {
      applyCompanionConfig(before, { reconcile: false });
      await nativeVoiceHost?.reconcile().catch(() => undefined);
      throw Error(`设置未应用，已恢复原设置：${error instanceof Error ? error.message : '请检查语音服务。'}`);
    }
  }
  if (!nativeVoiceHost || !next.voiceEnabled || next.mockMode) return next;
  try {
    await nativeVoiceStarting;
    const old = nativeVoiceHost; nativeVoiceHost = null;
    await old.close();
    await startNativeVoiceHost();
    if (!nativeVoiceHost || nativeVoiceError) throw Error(nativeVoiceError || '语音重新连接失败。');
    return { ...readCompanionConfig(), nativeVoiceManaged, nativeVoiceError, deviceId: voiceClientId };
  } catch (error) {
    // A failed reconnect must not claim that the new preference is active.
    applyCompanionConfig(Object.fromEntries(reconnectFields.map(field => [field, before[field]])), { reconcile: false });
    if (!nativeVoiceHost) await startNativeVoiceHost().catch(() => undefined);
    throw Error(`语音未重新连接，已恢复原设置：${error instanceof Error ? error.message : '请检查设备和语音资源。'}`);
  }
});
ipcMain.handle('companion:get-state', () => companionState);
ipcMain.handle('companion:set-state', (_event, state) => setCompanionState(state));
ipcMain.handle('companion:get-device-status', () => ({ microphone: 'pending', camera: 'pending', mode: 'mock', microphones: [], cameras: [] }));
ipcMain.handle('companion:show', () => { showCompanionWindow(); });
ipcMain.handle('companion:hide', () => { companionWindow?.hide(); });
ipcMain.handle('companion:open-main', (_event, target) => { showMainWindow(target); });
ipcMain.handle('computer:status',event=>{assertVoiceSettingsSender(event);return computerBridgeHost?.status()??{connected:false,active:false,error:'',deviceId:voiceClientId};});
ipcMain.handle('computer:connect',async event=>{assertVoiceSettingsSender(event);return localComputerHost().connect();});
ipcMain.handle('computer:disconnect',async event=>{assertVoiceSettingsSender(event);computerStartupRestore.cancel();return localComputerHost().disconnect();});
ipcMain.handle('assistant:set-focus',(event,target)=>{
  assertVoiceSettingsSender(event);
  if(!target||!['project','document','task','page'].includes(target.kind)||typeof target.id!=='string'||target.id.length>160||typeof target.title!=='string'||target.title.length>500)throw Error('当前页面信息无效。');
  interactionFocus={kind:target.kind,id:target.id,title:target.title};return {updated:true};
});
ipcMain.handle('companion:show-context-menu', () => { buildCompanionMenu().popup({ window: companionWindow ?? undefined }); });
ipcMain.handle('companion:list-voices', () => runSpeechScript('list-speech-voices.ps1'));
ipcMain.handle('companion:recognize-speech', async () => {
  if (speechProcess) speechProcess.kill();
  return runSpeechScript('recognize-speech.ps1', ['-TimeoutSeconds', '20']);
});
ipcMain.handle('companion:speak', async (_event, text) => {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new Error('朗读内容无效。');
  if (speechProcess) speechProcess.kill();
  const config = readCompanionConfig();
  const textPath = path.join(app.getPath('temp'), `ai-secretary-speech-${Date.now()}-${process.pid}.txt`);
  fs.writeFileSync(textPath, text, 'utf8');
  try { return await runSpeechScript('speak-text.ps1', ['-TextPath', textPath, '-Voice', config.voiceName || '', '-Rate', String(config.speechRate ?? 0), '-Volume', String(config.speechVolume ?? 100)]); }
  finally { fs.rmSync(textPath, { force: true }); }
});
ipcMain.handle('companion:stop-speech', () => { if (speechProcess) speechProcess.kill(); speechProcess = null; return true; });
ipcMain.on('companion:move-to-pointer', (_event, position) => {
  if (!companionWindow) return;
  const screenX = Number(position?.screenX);
  const screenY = Number(position?.screenY);
  const offsetX = Number(position?.offsetX);
  const offsetY = Number(position?.offsetY);
  if (![screenX, screenY, offsetX, offsetY].every(Number.isFinite)) return;
  const bounds = companionWindowSize(readCompanionConfig());
  const display = screen.getDisplayNearestPoint({ x: Math.round(screenX), y: Math.round(screenY) });
  const area = display.workArea;
  const x = Math.min(area.x + area.width - bounds.width, Math.max(area.x, Math.round(screenX - offsetX)));
  const y = Math.min(area.y + area.height - bounds.height, Math.max(area.y, Math.round(screenY - offsetY)));
  // Always write the configured pixel dimensions together with the position.
  // Windows can otherwise feed a DPI-adjusted window size back into subsequent
  // move events, which compounds while dragging across scaled displays.
  companionWindow.setBounds({ x, y, width: bounds.width, height: bounds.height }, false);
});

function isNewerVersion(candidate, current) {
  const candidateParts = String(candidate).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const currentParts = String(current).split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(candidateParts.length, currentParts.length); index += 1) {
    if ((candidateParts[index] || 0) !== (currentParts[index] || 0)) return (candidateParts[index] || 0) > (currentParts[index] || 0);
  }
  return false;
}

async function installLatestUpdate() {
  if (updateInFlight) return updateInFlight;
  updateInFlight = (async () => {
    const latestResponse = await fetch(`http://127.0.0.1:${appPort}/api/releases/latest`, { signal: AbortSignal.timeout(15000) });
    if (!latestResponse.ok) throw new Error((await latestResponse.json().catch(() => null))?.message || '无法读取服务器版本。');
    const release = await latestResponse.json();
    if (!isNewerVersion(release.version, app.getVersion())) return { status: 'up-to-date', release };

    const packageResponse = await fetch(`http://127.0.0.1:${appPort}${release.downloadUrl}`, { signal: AbortSignal.timeout(300000) });
    if (!packageResponse.ok) throw new Error('最新版安装包下载失败。');
    const packageBytes = Buffer.from(await packageResponse.arrayBuffer());
    if (Number(release.size) !== packageBytes.length) throw new Error('安装包大小与服务器记录不一致，已停止更新。');
    const digest = createHash('sha256').update(packageBytes).digest('hex');
    if (digest.toLowerCase() !== String(release.sha256).toLowerCase()) throw new Error('安装包校验失败，已停止更新。');

    const updateDirectory = path.join(app.getPath('temp'), 'Housekeeper-Updates');
    fs.mkdirSync(updateDirectory, { recursive: true });
    const installerPath = path.join(updateDirectory, path.basename(release.filename));
    fs.writeFileSync(installerPath, packageBytes);
    const updateLogPath = path.join(updateDirectory, 'update.log');
    fs.appendFileSync(updateLogPath, `${new Date().toISOString()} installer-launch-requested path=${installerPath}\r\n`, 'utf8');

    // Start the visible installer while the desktop app is still alive. The old
    // PowerShell hand-off could be terminated before it ever launched, leaving
    // the user with a closed app and no installer. Waiting for the child-process
    // spawn event removes that gap: only a confirmed installer process may close
    // the current application.
    const updater = spawn(installerPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: path.dirname(installerPath)
    });
    await new Promise((resolve, reject) => {
      updater.once('spawn', resolve);
      updater.once('error', reject);
    });
    fs.appendFileSync(updateLogPath, `${new Date().toISOString()} installer-process-started pid=${updater.pid ?? 0}\r\n`, 'utf8');
    updater.unref();
    setTimeout(() => app.exit(0), 600);
    return { status: 'installing', release };
  })().finally(() => { updateInFlight = null; });
  return updateInFlight;
}

ipcMain.handle('app:install-latest-update', installLatestUpdate);

function showPreviousUpdateFailure() {
  try {
    const statusPath = path.join(app.getPath('temp'), 'Housekeeper-Updates', 'status.json');
    if (!fs.existsSync(statusPath)) return;
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    if (status?.state !== 'error') return;
    fs.rmSync(statusPath, { force: true });
    dialog.showErrorBox('AI 秘书更新失败', `安装程序未能完成更新。应用已恢复启动，原有数据不会受影响。\n\n原因：${String(status.message || '未知错误')}\n\n请把更新日志发给维护人员：\n${path.join(app.getPath('temp'), 'Housekeeper-Updates', 'update.log')}`);
  } catch (error) {
    writeStartupError(error);
  }
}

function writeStartupError(error) {
  try {
    const logDirectory = app.getPath('logs');
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.appendFileSync(path.join(logDirectory, 'startup.log'), `${new Date().toISOString()} ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  } catch {
    // Logging must never prevent the error dialog from opening.
  }
}

function configureMediaPermissions() {
  const isLocalAppOrigin = (url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const source = requestingOrigin || webContents?.getURL() || '';
    return permission === 'media' && isLocalAppOrigin(source);
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const source = details?.requestingUrl || webContents?.getURL() || '';
    callback(permission === 'media' && isLocalAppOrigin(source));
  });
}

async function readEncryptedValueWithRetry(filePath) {
  if (safeStorage.isEncryptionAvailable() && fs.existsSync(filePath)) {
    try {
      const value = safeStorage.decryptString(fs.readFileSync(filePath));
      if (value) return value;
    } catch {
      // A legacy Electron profile can leave an unreadable token behind. The
      // tailnet-only server does not require it, so startup must continue now.
    }
  }
  return '';
}

async function configureLocalData() {
  require('./companion-voice-update.cjs').migrateNativeVoiceFlags(companionConfigPath,nativeVoiceManaged);
  // The desktop build is a thin client. It may keep device configuration and
  // scan the local Vault for upload, but business features must never fall
  // back to the local database when the central server is unavailable.
  process.env.AI_SECRETARY_CLIENT_MODE = '1';
  const localDataDirectory = path.join(persistentDataDirectory, 'data');
  const secretPath = path.join(persistentDataDirectory, 'api-key.secure');
  const retrievalSecretPath = path.join(persistentDataDirectory, 'retrieval-api-key.secure');
  const webSearchSecretPath = path.join(persistentDataDirectory, 'tavily-api-key.secure');
  const visionSecretPath = path.join(persistentDataDirectory, 'vision-api-key.secure');
  global.__AI_SECRETARY_VISION_SECRET_STORE__ = {
    load(){if(!safeStorage.isEncryptionAvailable()||!fs.existsSync(visionSecretPath))return null;try{return safeStorage.decryptString(fs.readFileSync(visionSecretPath));}catch{return null;}},
    save(value){if(!safeStorage.isEncryptionAvailable())throw new Error('当前系统无法使用安全存储。');fs.mkdirSync(path.dirname(visionSecretPath),{recursive:true});fs.writeFileSync(visionSecretPath,safeStorage.encryptString(value));},
    clear(){if(fs.existsSync(visionSecretPath))fs.unlinkSync(visionSecretPath);}
  };
  const remoteUrlPath = path.join(persistentDataDirectory, 'remote-server-url.txt');
  const remoteTokenPath = path.join(persistentDataDirectory, 'remote-server-token.secure');
  global.__AI_SECRETARY_SECRET_STORE__ = {
    load() {
      if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(secretPath)) return null;
      try { return safeStorage.decryptString(fs.readFileSync(secretPath)); } catch { return null; }
    },
    save(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法使用安全存储。');
      fs.mkdirSync(path.dirname(secretPath), { recursive: true });
      fs.writeFileSync(secretPath, safeStorage.encryptString(value));
    },
    clear() {
      if (fs.existsSync(secretPath)) fs.unlinkSync(secretPath);
    }
  };
  global.__AI_SECRETARY_RETRIEVAL_SECRET_STORE__ = {
    load() {
      if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(retrievalSecretPath)) return null;
      try { return safeStorage.decryptString(fs.readFileSync(retrievalSecretPath)); } catch { return null; }
    },
    save(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法使用安全存储。');
      fs.mkdirSync(path.dirname(retrievalSecretPath), { recursive: true });
      fs.writeFileSync(retrievalSecretPath, safeStorage.encryptString(value));
    },
    clear() {
      if (fs.existsSync(retrievalSecretPath)) fs.unlinkSync(retrievalSecretPath);
    }
  };
  global.__AI_SECRETARY_WEB_SEARCH_SECRET_STORE__ = {
    load() {
      if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(webSearchSecretPath)) return null;
      try { return safeStorage.decryptString(fs.readFileSync(webSearchSecretPath)); } catch { return null; }
    },
    save(value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法使用安全存储。');
      fs.mkdirSync(path.dirname(webSearchSecretPath), { recursive: true });
      fs.writeFileSync(webSearchSecretPath, safeStorage.encryptString(value));
    },
    clear() {
      if (fs.existsSync(webSearchSecretPath)) fs.unlinkSync(webSearchSecretPath);
    }
  };
  const requestedRemoteUrl = process.env.AI_SECRETARY_CONFIGURE_REMOTE_URL?.trim().replace(/\/+$/, '') || '';
  const requestedRemoteToken = process.env.AI_SECRETARY_CONFIGURE_REMOTE_TOKEN?.trim() || '';
  if (requestedRemoteUrl && requestedRemoteToken) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法安全保存服务器连接令牌。');
    fs.mkdirSync(persistentDataDirectory, { recursive: true });
    fs.writeFileSync(remoteUrlPath, requestedRemoteUrl, 'utf8');
    fs.writeFileSync(remoteTokenPath, safeStorage.encryptString(requestedRemoteToken));
  }
  const savedRemoteUrl = requestedRemoteUrl || (fs.existsSync(remoteUrlPath) ? fs.readFileSync(remoteUrlPath, 'utf8').trim().replace(/\/+$/, '') : '');
  // The central service is bound only to its Tailscale address. A bearer token
  // remains supported, but a stale Chromium safeStorage profile must never
  // prevent a tailnet-only client from starting and reaching that service.
  const savedRemoteToken = requestedRemoteToken || await readEncryptedValueWithRetry(remoteTokenPath);
  if (savedRemoteUrl) {
    process.env.AI_SECRETARY_REMOTE_URL = savedRemoteUrl;
    if (savedRemoteToken) process.env.AI_SECRETARY_REMOTE_TOKEN = savedRemoteToken;
    else delete process.env.AI_SECRETARY_REMOTE_TOKEN;
  }
  process.env.AI_SECRETARY_DB_PATH = path.join(localDataDirectory, 'housekeeper.db');
  process.env.AI_SECRETARY_SKILLS_DIR = path.join(persistentDataDirectory, 'skills', 'managed');
  process.env.AI_SECRETARY_STATIC_DIR = path.join(app.getAppPath(), 'dist');
  process.env.AI_SECRETARY_PORT = String(appPort);
}

async function waitForLocalService() {
  const healthUrl = `http://127.0.0.1:${appPort}/api/health`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
    } catch {
      // The local service can take a moment on the first launch.
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error('本地服务启动超时。');
}

async function startLocalService() {
  await configureLocalData();
  const serverEntry = path.join(app.getAppPath(), 'build', 'server', 'index.js');
  await import(pathToFileURL(serverEntry).href);
  await waitForLocalService();
}

const {createStartupRestore}=require('./startup-restore.cjs');
const voiceStartupRestore=createStartupRestore({
  enabled:()=>{const c=readCompanionConfig();return !isQuitting&&nativeVoiceManaged&&c.voiceEnabled!==false&&!c.mockMode;},
  async start(){
    if(nativeVoiceHost)await nativeVoiceHost.reconcile();else await startNativeVoiceHost();
    return Boolean(nativeVoiceHost?.status().running);
  }
});
const computerStartupRestore=createStartupRestore({
  enabled:()=>!isQuitting&&require('./computer-bridge-host.cjs').computerAutoConnect(persistentDataDirectory),
  async start(){return (await localComputerHost().restore()).connected;}
});
function restoreDesktopConnections(){
  void voiceStartupRestore.restore();
  void computerStartupRestore.restore();
}
function publishNativeVoiceStatus(){
  const config={...readCompanionConfig(),nativeVoiceManaged,nativeVoiceError,nativeVoiceStarting:Boolean(nativeVoiceStarting),deviceId:voiceClientId};
  for(const window of [mainWindow,companionWindow])if(window&&!window.isDestroyed())window.webContents.send('companion:config-changed',config);
}
function startNativeVoiceHost() {
  if (!nativeVoiceStarting){
    nativeVoiceStarting = initializeNativeVoiceHost().finally(() => { nativeVoiceStarting = null;publishNativeVoiceStatus(); });
    publishNativeVoiceStatus();
  }
  return nativeVoiceStarting;
}

async function initializeNativeVoiceHost() {
  if (!nativeVoiceManaged) return;
  const { createNativeVoiceHost } = require('./native-voice-host.cjs');
  const { startNativeVoiceSafely } = require('./native-voice-startup.cjs');
  const { SettingsService } = await import(pathToFileURL(path.join(app.getAppPath(), 'build/server/domain/settings/settings-service.js')).href);
  const nativeSettings = new SettingsService();
  const trace = require('./voice-startup-trace.cjs').createVoiceStartupTrace(path.join(persistentDataDirectory, 'logs/native-voice-startup.json'));
  trace.mark('settings');
  const result = await startNativeVoiceSafely(async () => {
    // The local API bridge mirrors the central connection into this device's
    // settings before the native worker reads it. A failed refresh must not
    // silently start with an unrelated, possibly stale SQLite value.
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/settings`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw Error('VOICE_SETTINGS_SYNC_FAILED');
      await response.body?.cancel();
    } catch { throw Error('VOICE_SETTINGS_SYNC_FAILED'); }
    return createNativeVoiceHost({ configFile: nativeVoiceConfigFile, resourceBundleRoot: activeVoiceBundleRoot || undefined, appRoot: app.getAppPath(), workerRoot: nativeVoiceWorkerRoot,
    dataDirectory: persistentDataDirectory, deviceId: voiceClientId, port: appPort, readCompanionConfig, readDevices:()=>nativeVoiceDevices.read(),onStartupStage:trace.mark,onNavigation:receiveNavigation,onActivity:event=>mainWindow?.webContents.send('assistant:voice-activity',event),onComputerControl:action=>action==='connect'?localComputerHost().connect():localComputerHost().disconnect(),
    captureCameraFrame:signal=>cameraFrames.capture(signal),
    onPlaybackLevel:level=>mainWindow?.webContents.send('companion:playback-level',level),
    readConnection: () => voiceConnectionHold?.snapshot?.settings ?? nativeSettings.nativeVoiceConnection(),
    key: purpose => voiceConnectionHold?.snapshot?.keys[purpose] ?? voiceSecrets.load(purpose) ?? null,
    onStatus: event => {
      const previousError = nativeVoiceError;
      nativeVoiceError = voiceStatusMessage(nativeVoiceError,event);
      setCompanionState(voiceStatusState(event));
      if (previousError !== nativeVoiceError) {
        publishNativeVoiceStatus();
      }
    }
    });
  }, { onFailure: ({code}) => trace.finish('failed', code) });
  if(result.host)trace.finish(result.host.status().running?'ready':'paused');
  if(isQuitting){await result.host?.close();return;}
  nativeVoiceHost = result.host; nativeVoiceError = result.error;
  publishNativeVoiceStatus();
  if (nativeVoiceError) setCompanionState('idle');
}

// Inline the local stylesheet so the first screen needs no server or network.
const startupHtml = fs.readFileSync(path.join(__dirname, 'startup.html'), 'utf8').replace('<link rel="stylesheet" href="./startup.css">', `<style>${fs.readFileSync(path.join(__dirname, 'startup.css'), 'utf8')}</style>`);
const startupPage = `data:text/html;charset=utf-8,${encodeURIComponent(startupHtml)}`;
function createMainWindow({ loading = false } = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f2f3f7',
    title: displayName,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  mainWindow = window;
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
  window.on('close', (event) => {
    if (!localServiceReady && !isQuitting) {
      isQuitting = true;
      app.quit();
      return;
    }
    if (!isQuitting && readCompanionConfig().enabled) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  void window.loadURL(loading ? startupPage : `http://127.0.0.1:${appPort}/`);
  return window;
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function selectLocalBridge() {
  for (let candidate = DEFAULT_APP_PORT; candidate < DEFAULT_APP_PORT + 10; candidate += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${candidate}/api/health`, { signal: AbortSignal.timeout(750) });
      const health = response.ok ? await response.json().catch(() => null) : null;
      if (health?.version === app.getVersion() && health?.serverConnected === true) {
        appPort = candidate;
        return true;
      }
    } catch {
      // A failed health request may mean the port is free or belongs to another process.
    }
    if (await isPortAvailable(candidate)) {
      appPort = candidate;
      return false;
    }
  }
  throw new Error('无法启动客户端连接服务，请关闭残留的 AI 秘书进程后重试。');
}

if (!ownsSingleInstanceLock) {
  app.quit();
} else app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else if (localServiceReady) showMainWindow('chat');
});

if (ownsSingleInstanceLock) app.whenReady().then(async () => {
  try {
    configureMediaPermissions();
    showPreviousUpdateFailure();
    createMainWindow({ loading: true });
    // Reuse only a current, connected bridge. A stale bridge left by an
    // interrupted upgrade must not make the new client appear disconnected or
    // serve the previous version's interface.
    const reuseExistingBridge = await selectLocalBridge();
    if (isQuitting) return;
    if (reuseExistingBridge) {
      if (nativeVoiceManaged) await configureLocalData();
      if (isQuitting) return;
      localServiceReady = true;
      if (!mainWindow) createMainWindow();
      else void mainWindow.loadURL(`http://127.0.0.1:${appPort}/`);
      createTray();
      if (readCompanionConfig().enabled) createCompanionWindow();
      restoreDesktopConnections();
      return;
    }
    await startLocalService();
    if (isQuitting) return;
    localServiceReady = true;
    if (!mainWindow) createMainWindow();
    else void mainWindow.loadURL(`http://127.0.0.1:${appPort}/`);
    createTray();
    if (readCompanionConfig().enabled) createCompanionWindow();
    restoreDesktopConnections();
  } catch (error) {
    writeStartupError(error);
    dialog.showErrorBox('AI 秘书无法启动', error instanceof Error ? error.message : '本地服务启动失败。');
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

app.on('before-quit', event => {
  isQuitting = true;
  voiceStartupRestore.close();computerStartupRestore.close();
  if(computerBridgeHost){event.preventDefault();const host=computerBridgeHost;computerBridgeHost=null;void host.close().catch(()=>{}).finally(()=>app.quit());return;}
  if(nativeVoiceStarting){event.preventDefault();void nativeVoiceStarting.catch(()=>{}).finally(()=>app.quit());return;}
  if (nativeVoiceHost) {
    event.preventDefault(); const host = nativeVoiceHost; nativeVoiceHost = null;
    void host.close().catch(() => {}).finally(() => app.quit());
  }
});
