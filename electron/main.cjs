const { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, screen, session, shell, Tray } = require('electron');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DEFAULT_APP_PORT = 43120;
let appPort = DEFAULT_APP_PORT;
const persistentDataDirectory = path.join(app.getPath('appData'), 'housekeeper');
// v0.4 uses a fresh Electron runtime profile so an orphaned mutex from the
// legacy desktop build cannot prevent startup. Business data and encrypted
// secrets intentionally remain in the established persistent data directory.
app.setPath('userData', path.join(app.getPath('appData'), 'housekeeper-runtime'));
let mainWindow = null;
let companionWindow = null;
let tray = null;
let isQuitting = false;
let companionState = 'idle';
let updateInFlight = null;
let speechProcess = null;
const ownsSingleInstanceLock = app.requestSingleInstanceLock();

const companionConfigPath = path.join(persistentDataDirectory, 'desktop-companion.json');
const defaultCompanionConfig = Object.freeze({
  enabled: false,
  alwaysOnTop: true,
  appearance: 'character',
  iconSize: 64,
  characterHeight: 240,
  opacity: 1,
  motion: 'full',
  launchAtStartup: false,
  idleHideMinutes: 0,
  mockMode: true,
  voiceName: 'Microsoft Yaoyao',
  speechRate: 0,
  speechVolume: 100,
  cameraContextEnabled: false,
  voiceChatModel: '',
  visionModel: '',
  wakeWordEnabled: false,
  wakeWord: '小E小E',
  wakeWordThreshold: 0.66
});

function readCompanionConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(companionConfigPath, 'utf8'));
    const { size: _legacyScale, ...current } = saved ?? {};
    return { ...defaultCompanionConfig, ...current, appearance: current.appearance === 'icon' ? 'icon' : 'character', iconSize: Number.isFinite(current.iconSize) ? Math.min(96, Math.max(48, Math.round(current.iconSize))) : defaultCompanionConfig.iconSize, characterHeight: Number.isFinite(current.characterHeight) ? Math.min(300, Math.max(180, Math.round(current.characterHeight))) : defaultCompanionConfig.characterHeight, position: saved?.position };
  } catch {
    return { ...defaultCompanionConfig };
  }
}

function saveCompanionConfig(config) {
  fs.mkdirSync(path.dirname(companionConfigPath), { recursive: true });
  fs.writeFileSync(companionConfigPath, JSON.stringify(config, null, 2), 'utf8');
}

function sanitizeCompanionChanges(changes) {
  const next = {};
  if (typeof changes?.enabled === 'boolean') next.enabled = changes.enabled;
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
  if (typeof changes?.voiceName === 'string') next.voiceName = changes.voiceName.slice(0, 160);
  if (Number.isFinite(changes?.speechRate)) next.speechRate = Math.min(5, Math.max(-5, Math.round(Number(changes.speechRate))));
  if (Number.isFinite(changes?.speechVolume)) next.speechVolume = Math.min(100, Math.max(0, Math.round(Number(changes.speechVolume))));
  if (typeof changes?.cameraContextEnabled === 'boolean') next.cameraContextEnabled = changes.cameraContextEnabled;
  if (typeof changes?.voiceChatModel === 'string') next.voiceChatModel = changes.voiceChatModel.slice(0, 160);
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
    { label: companionWindow?.isVisible() ? '隐藏小E' : '显示小E', click: () => companionWindow?.isVisible() ? companionWindow.hide() : showCompanionWindow() },
    { label: '打开 AI 秘书', click: () => showMainWindow('chat') },
    { label: '桌面小E设置', click: () => showMainWindow('settings') },
    { type: 'separator' },
    { label: '开始聆听', enabled: config.mockMode, click: () => setCompanionState('listening') },
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
  tray.setToolTip('小E · AI 秘书');
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
    const match = typeof message === 'string' && message.match(/^\[voice-(timing|error)\] (.*)$/);
    if (!match) return;
    try {
      const value = JSON.parse(match[2]);
      const record = { at: new Date().toISOString(), kind: match[1], stage: String(value.stage || '').replace(/[^a-z-]/g, '').slice(0, 48), ms: Number.isFinite(value.ms) ? value.ms : undefined, code: String(value.code || '').replace(/[^A-Za-z]/g, '').slice(0, 32) };
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
}

function applyCompanionConfig(changes) {
  const config = { ...readCompanionConfig(), ...sanitizeCompanionChanges(changes) };
  saveCompanionConfig(config);
  app.setLoginItemSettings({ openAtLogin: config.launchAtStartup, openAsHidden: false });
  if (companionWindow) {
    const bounds = companionWindowSize(config);
    const position = resolvedCompanionPosition(config, bounds);
    companionWindow.setBounds({ ...position, ...bounds });
    companionWindow.setOpacity(config.opacity);
    companionWindow.setAlwaysOnTop(config.alwaysOnTop, config.alwaysOnTop ? 'floating' : 'normal');
    companionWindow.webContents.send('companion:config-changed', config);
    if (config.enabled) companionWindow.showInactive(); else companionWindow.hide();
  } else if (config.enabled && app.isReady()) {
    showCompanionWindow();
  }
  return config;
}

ipcMain.handle('companion:get-config', () => readCompanionConfig());
ipcMain.handle('companion:update-config', (_event, changes) => applyCompanionConfig(changes));
ipcMain.handle('companion:get-state', () => companionState);
ipcMain.handle('companion:set-state', (_event, state) => setCompanionState(state));
ipcMain.handle('companion:get-device-status', () => ({ microphone: 'pending', camera: 'pending', mode: 'mock', microphones: [], cameras: [] }));
ipcMain.handle('companion:show', () => { showCompanionWindow(); });
ipcMain.handle('companion:hide', () => { companionWindow?.hide(); });
ipcMain.handle('companion:open-main', (_event, target) => { showMainWindow(target); });
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

    const updateDirectory = path.join(app.getPath('temp'), 'AI-Secretary-Updates');
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
    const statusPath = path.join(app.getPath('temp'), 'AI-Secretary-Updates', 'status.json');
    if (!fs.existsSync(statusPath)) return;
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    if (status?.state !== 'error') return;
    fs.rmSync(statusPath, { force: true });
    dialog.showErrorBox('AI 秘书更新失败', `安装程序未能完成更新。应用已恢复启动，原有数据不会受影响。\n\n原因：${String(status.message || '未知错误')}\n\n请把更新日志发给维护人员：\n${path.join(app.getPath('temp'), 'AI-Secretary-Updates', 'update.log')}`);
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
  // Public edition is standalone by default, with an independent data profile.
  process.env.AI_SECRETARY_CLIENT_MODE = '0';
  const localDataDirectory = path.join(persistentDataDirectory, 'data');
  const secretPath = path.join(persistentDataDirectory, 'api-key.secure');
  const retrievalSecretPath = path.join(persistentDataDirectory, 'retrieval-api-key.secure');
  const webSearchSecretPath = path.join(persistentDataDirectory, 'tavily-api-key.secure');
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
    process.env.AI_SECRETARY_CLIENT_MODE = '1';
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

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f7f8fa',
    title: 'AI 秘书',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (!isQuitting && readCompanionConfig().enabled) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  void mainWindow.loadURL(`http://127.0.0.1:${appPort}/`);
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
  } else if (app.isReady()) showMainWindow('chat');
});

if (ownsSingleInstanceLock) app.whenReady().then(async () => {
  try {
    configureMediaPermissions();
    showPreviousUpdateFailure();
    // Reuse only a current, connected bridge. A stale bridge left by an
    // interrupted upgrade must not make the new client appear disconnected or
    // serve the previous version's interface.
    const reuseExistingBridge = await selectLocalBridge();
    if (reuseExistingBridge) {
      createMainWindow();
      createTray();
      if (readCompanionConfig().enabled) createCompanionWindow();
      return;
    }
    await startLocalService();
    createMainWindow();
    createTray();
    if (readCompanionConfig().enabled) createCompanionWindow();
  } catch (error) {
    writeStartupError(error);
    dialog.showErrorBox('AI 秘书无法启动', error instanceof Error ? error.message : '本地服务启动失败。');
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

app.on('before-quit', () => { isQuitting = true; });
