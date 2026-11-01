'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WINDOWS_MCP_VERSION = '0.8.8';
const WINDOWS_MCP_TOOL_POLICY = Object.freeze({
  ControlStatus: 'read', DisplayInventory: 'read', Snapshot: 'read', Screenshot: 'read',
  Wait: 'read', WaitFor: 'read',
  App: 'write', Click: 'write', Type: 'write', Scroll: 'write', Move: 'write', Shortcut: 'write',
});
const APP_NAMES = Object.freeze(['notepad', '记事本', 'calculator', '计算器', 'paint', '画图', 'word', 'excel', 'powerpoint', 'wps office', 'wps', '文件资源管理器', '资源管理器', 'explorer', 'microsoft edge', 'msedge', 'google chrome', 'chrome']);
const SHORTCUTS = Object.freeze([
  'enter', 'tab', 'shift+tab', 'esc', 'escape', 'space', 'backspace', 'delete',
  'left', 'right', 'up', 'down', 'home', 'end', 'pageup', 'pagedown',
  'ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z', 'ctrl+y', 'ctrl+s', 'ctrl+f',
  'ctrl+n', 'ctrl+shift+n', 'ctrl+tab', 'ctrl+shift+tab', 'ctrl+w', 'alt+f4',
]);
const FIELDS = Object.freeze({
  ControlStatus: [], DisplayInventory: [],
  Snapshot: ['use_vision', 'use_dom', 'use_annotation', 'use_ui_tree', 'width_reference_line', 'height_reference_line', 'display', 'region'],
  Screenshot: ['use_annotation', 'width_reference_line', 'height_reference_line', 'display', 'region'],
  Wait: ['duration'], WaitFor: ['condition', 'text', 'window_name', 'timeout', 'interval', 'use_dom'],
  App: ['mode', 'name', 'window_loc', 'window_size'],
  Click: ['loc', 'label', 'button', 'clicks'], Type: ['text', 'loc', 'label', 'clear', 'caret_position', 'press_enter'],
  Scroll: ['loc', 'label', 'type', 'direction', 'wheel_times'],
  Move: ['loc', 'label', 'drag', 'from_loc', 'duration'], Shortcut: ['shortcut'],
});

class WindowsMcpError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WindowsMcpError';
    this.code = code;
    this.outcomeUnknown = details.outcomeUnknown === true;
    if (details.tool) this.tool = details.tool;
  }
}
const fault = (code, message, details) => new WindowsMcpError(code, message, details);
const aborted = () => fault('WINDOWS_MCP_CANCELLED', 'Windows 操作已取消。');
const clone = value => JSON.parse(JSON.stringify(value));
const validTimeout = (value, fallback, max = 300_000) => Number.isFinite(value) && value >= 10 && value <= max ? Math.round(value) : fallback;

function resolveUvx() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'hermes', 'bin', 'uvx.exe'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.local', 'bin', 'uvx.exe'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir.replace(/^"|"$/g, ''), 'uvx.exe')),
  ];
  const executable = candidates.find(candidate => candidate && path.isAbsolute(candidate) && fs.existsSync(candidate));
  if (!executable) throw fault('WINDOWS_MCP_UVX_MISSING', '未找到 uvx，请先在 Windows 客户端安装 uv。');
  return executable;
}

function validateArguments(name, input) {
  if (!Object.hasOwn(WINDOWS_MCP_TOOL_POLICY, name)) throw fault('WINDOWS_MCP_TOOL_BLOCKED', '此 Windows 工具未获本地允许。');
  if (!input || Object.prototype.toString.call(input) !== '[object Object]') {
    throw fault('WINDOWS_MCP_ARGUMENTS_INVALID', 'Windows 工具参数必须是普通对象。');
  }
  let args;
  try {
    const encoded = JSON.stringify(input);
    if (Buffer.byteLength(encoded) > 50_000) throw Error();
    args = JSON.parse(encoded);
  } catch { throw fault('WINDOWS_MCP_ARGUMENTS_INVALID', 'Windows 工具参数过大或无法编码。'); }
  const fail = () => { throw fault('WINDOWS_MCP_ARGUMENTS_INVALID', 'Windows 工具参数不在本地允许范围。'); };
  for (const key of Object.keys(input)) if (!FIELDS[name].includes(key) || input[key] === undefined || args[key] !== input[key] && typeof input[key] !== 'object') fail();
  for (const key of ['use_vision', 'use_dom', 'use_annotation', 'use_ui_tree', 'clear', 'press_enter', 'drag']) if (key in args && typeof args[key] !== 'boolean') fail();
  for (const key of ['text', 'window_name']) if (key in args && (typeof args[key] !== 'string' || args[key].length > 10_000)) fail();
  const pair = (value, size) => Array.isArray(value) && value.length === size && value.every(v => Number.isInteger(v) && Math.abs(v) <= 100_000);
  for (const key of ['loc', 'from_loc', 'window_loc', 'window_size']) if (key in args && !pair(args[key], 2)) fail();
  if ('region' in args && !pair(args.region, 4)) fail();
  if ('display' in args && (!Array.isArray(args.display) || args.display.length > 16 || args.display.some(v => !Number.isInteger(v) || v < 0 || v > 31))) fail();
  if ('label' in args && (!Number.isInteger(args.label) || args.label < 0)) fail();
  for (const key of ['width_reference_line', 'height_reference_line']) if (key in args && (!Number.isInteger(args[key]) || args[key] < 1 || args[key] > 100)) fail();
  if (name === 'App') {
    args.mode ??= 'launch';
    if (!['launch', 'switch', 'resize'].includes(args.mode) || typeof args.name !== 'string' || !args.name.trim() || args.name.length > 200) fail();
    if (args.mode === 'launch' && !APP_NAMES.includes(args.name.toLowerCase())) fail();
    if (args.mode !== 'resize' && ('window_loc' in args || 'window_size' in args)) fail();
  }
  if (name === 'Shortcut') {
    if (typeof args.shortcut !== 'string') fail();
    args.shortcut = args.shortcut.toLowerCase().replace(/\s+/g, '');
    if (!SHORTCUTS.includes(args.shortcut)) fail();
  }
  if (['Click', 'Type', 'Move'].includes(name) && !('loc' in args) && !('label' in args)) fail();
  if (name === 'Type' && typeof args.text !== 'string') fail();
  if (name === 'Click' && ('clicks' in args && ![0, 1, 2].includes(args.clicks) || 'button' in args && !['left', 'right', 'middle'].includes(args.button))) fail();
  if (name === 'Type' && 'caret_position' in args && !['start', 'idle', 'end'].includes(args.caret_position)) fail();
  if (name === 'Scroll') {
    if ('type' in args && !['vertical', 'horizontal'].includes(args.type) || 'direction' in args && !['up', 'down', 'left', 'right'].includes(args.direction)) fail();
    if ('wheel_times' in args && (!Number.isInteger(args.wheel_times) || args.wheel_times < 1 || args.wheel_times > 100)) fail();
  }
  if (name === 'Wait' && (!Number.isInteger(args.duration) || args.duration < 0 || args.duration > 30)) fail();
  if (name === 'Move' && 'duration' in args && (!Number.isFinite(args.duration) || args.duration < 0 || args.duration > 10)) fail();
  if (name === 'Move' && ('from_loc' in args || 'duration' in args) && args.drag !== true) fail();
  if (name === 'WaitFor') {
    if (!['text_exists', 'active_window', 'element_exists', 'element_enabled', 'focused_element'].includes(args.condition)) fail();
    if ('timeout' in args && (!Number.isFinite(args.timeout) || args.timeout <= 0 || args.timeout > 30)) fail();
    if ('interval' in args && (!Number.isFinite(args.interval) || args.interval < 0.1 || args.interval > 5)) fail();
  }
  return args;
}

function exposeTool(tool) {
  const inputSchema = clone(tool.inputSchema);
  inputSchema.properties = Object.fromEntries(Object.entries(inputSchema.properties || {}).filter(([key]) => FIELDS[tool.name].includes(key)));
  inputSchema.additionalProperties = false;
  for (const key of Object.keys(inputSchema.properties)) {
    const old = inputSchema.properties[key];
    if (['use_vision', 'use_dom', 'use_annotation', 'use_ui_tree', 'clear', 'press_enter', 'drag'].includes(key)) {
      inputSchema.properties[key] = { type: 'boolean', ...(typeof old.default === 'boolean' ? { default: old.default } : {}) };
    }
    if (['text', 'window_name'].includes(key)) inputSchema.properties[key] = { type: 'string', maxLength: 10_000 };
    if (['loc', 'from_loc', 'window_loc', 'window_size', 'region'].includes(key)) {
      const length = key === 'region' ? 4 : 2;
      inputSchema.properties[key] = { type: 'array', items: { type: 'integer', minimum: -100_000, maximum: 100_000 }, minItems: length, maxItems: length };
    }
    if (key === 'display') inputSchema.properties[key] = { type: 'array', items: { type: 'integer', minimum: 0, maximum: 31 }, maxItems: 16 };
    if (key === 'label') inputSchema.properties[key] = { type: 'integer', minimum: 0 };
    if (['width_reference_line', 'height_reference_line'].includes(key)) inputSchema.properties[key] = { type: 'integer', minimum: 1, maximum: 100 };
  }
  if (tool.name === 'App') {
    inputSchema.properties.mode = { type: 'string', enum: ['launch', 'switch', 'resize'], default: 'launch' };
    inputSchema.properties.name = { type: 'string', minLength: 1, maxLength: 200 };
    inputSchema.required = ['name'];
    inputSchema.allOf = [{ if: { properties: { mode: { const: 'launch' } } }, then: { properties: { name: { enum: [...APP_NAMES] } } } }];
  }
  if (tool.name === 'Shortcut') inputSchema.properties.shortcut = { type: 'string', enum: [...SHORTCUTS] };
  if (tool.name === 'Wait') inputSchema.properties.duration = { type: 'integer', minimum: 0, maximum: 30 };
  if (tool.name === 'Click') inputSchema.properties.clicks = { type: 'integer', enum: [0, 1, 2], default: 1 };
  if (tool.name === 'Scroll') inputSchema.properties.wheel_times = { type: 'integer', minimum: 1, maximum: 100, default: 1 };
  if (tool.name === 'Move') inputSchema.properties.duration = { type: 'number', minimum: 0, maximum: 10 };
  if (tool.name === 'WaitFor') {
    inputSchema.properties.condition = { type: 'string', enum: ['text_exists', 'active_window', 'element_exists', 'element_enabled', 'focused_element'] };
    inputSchema.properties.timeout = { type: 'number', exclusiveMinimum: 0, maximum: 30, default: 10 };
    inputSchema.properties.interval = { type: 'number', minimum: 0.1, maximum: 5, default: 0.25 };
  }
  if (['Click', 'Type', 'Move'].includes(tool.name)) inputSchema.anyOf = [{ required: ['loc'] }, { required: ['label'] }];
  return {
    name: tool.name, description: tool.name === 'App' ? '启动已允许的记事本、计算器或画图；按名称切换或调整窗口。禁止命令、可执行路径及启动参数。' : tool.name === 'Shortcut' ? '执行本地枚举中的常见编辑快捷键；不允许 Windows 键、运行对话框或任务管理器。' : tool.description,
    inputSchema, access: WINDOWS_MCP_TOOL_POLICY[tool.name], readOnly: WINDOWS_MCP_TOOL_POLICY[tool.name] === 'read',
    annotations: { readOnlyHint: WINDOWS_MCP_TOOL_POLICY[tool.name] === 'read', destructiveHint: WINDOWS_MCP_TOOL_POLICY[tool.name] === 'write', idempotentHint: false },
  };
}

function normalizeResult(name, result) {
  let errorCode;
  const messages = (result.content || []).filter(item => item.type === 'text').map(item => item.text);
  for (const text of messages) {
    try {
      const value = JSON.parse(text);
      if (['USER_CONTROL', 'TAKEOVER_PENDING', 'CONTROL_UNAVAILABLE', 'CONTROL_PREEMPTED'].includes(value.code)) { errorCode = value.code; break; }
    } catch {}
  }
  if (!errorCode && name === 'App' && messages.some(text => /(?:not found in start menu\.|^Application .+ not found\.)$/i.test(text))) errorCode = 'WINDOWS_MCP_APP_NOT_FOUND';
  if (!errorCode && name === 'App' && messages.some(text => /^(?:No active window found|Failed to |Error switching app:)/i.test(text))) errorCode = 'WINDOWS_MCP_APP_FAILED';
  if (!errorCode && ['Snapshot', 'Screenshot'].includes(name) && messages.some(text => /^Error capturing (?:desktop state|screenshot):/i.test(text))) errorCode = 'WINDOWS_MCP_SNAPSHOT_FAILED';
  if (!errorCode && result.isError) errorCode = 'WINDOWS_MCP_TOOL_FAILED';
  if (!errorCode) return { result };
  const definitelyNotExecuted = ['USER_CONTROL', 'TAKEOVER_PENDING', 'WINDOWS_MCP_APP_NOT_FOUND'].includes(errorCode);
  return { result: { ...result, isError: true }, errorCode, outcomeUnknown: WINDOWS_MCP_TOOL_POLICY[name] === 'write' && !definitelyNotExecuted };
}

async function loadDefaultSdk() {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  return { Client, StdioClientTransport };
}

/** Main-process only. Never pass renderer-supplied configuration to this factory.
 * loadSdk/platform are dependency seams for node:test, not IPC options.
 * No command, arguments, transport, environment or package-version override exists.
 */
function createWindowsMcpClient({ startupTimeoutMs = 120_000, requestTimeoutMs = 30_000, shutdownTimeoutMs = 6_000, onStatus, loadSdk = loadDefaultSdk, platform = process.platform } = {}) {
  startupTimeoutMs = validTimeout(startupTimeoutMs, 120_000);
  requestTimeoutMs = validTimeout(requestTimeoutMs, 30_000, 120_000);
  shutdownTimeoutMs = validTimeout(shutdownTimeoutMs, 6_000, 10_000);
  let state = 'stopped', client = null, transport = null, configDirectory = null, catalog = [];
  let lastError = null, startedAt = null, active = null, draining = false, stopping = null;
  let cleanupPendingPid = null;
  const queue = [];
  const status = () => ({ state, version: WINDOWS_MCP_VERSION, platform, pid: transport?.pid || cleanupPendingPid || null, cleanupPending: Boolean(cleanupPendingPid), startedAt, queued: queue.length, activeTool: active?.tool || null, tools: catalog.map(t => ({ name: t.name, access: t.access })), lastError: lastError ? { ...lastError } : null });
  const notify = () => { try { onStatus?.(status()); } catch {} };
  const rememberError = error => { lastError = { code: error.code || 'WINDOWS_MCP_FAILED', message: error.message }; notify(); };
  const unavailable = () => fault('WINDOWS_MCP_NOT_READY', 'Windows 控制服务尚未就绪，请在客户端启动后重试。');
  function rejectQueue(error) {
    for (const job of queue.splice(0)) { job.signal?.removeEventListener('abort', job.abortQueued); job.reject(error); }
  }
  async function dispose() {
    const oldClient = client, oldTransport = transport, oldDirectory = configDirectory;
    const ownPid = oldTransport?.pid;
    client = null; transport = null; configDirectory = null; catalog = []; startedAt = null;
    if (oldClient || oldTransport) {
      let timer, closed = false;
      try {
        await Promise.race([
          Promise.resolve().then(() => oldClient ? oldClient.close() : oldTransport.close()).then(() => { closed = true; }).catch(() => {}),
          new Promise(resolve => { timer = setTimeout(resolve, shutdownTimeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
      // The SDK closes stdin, waits, then sends TERM/KILL to its own child.
      // If it cannot finish, retain the PID and report failed cleanup honestly.
      // Never expose a generic process-kill tool or kill application windows.
      if (!closed) cleanupPendingPid = ownPid || -1;
      else if (loadSdk === loadDefaultSdk && ownPid) {
        try { process.kill(ownPid, 0); cleanupPendingPid = ownPid; }
        catch (error) { if (error.code !== 'ESRCH') cleanupPendingPid = ownPid; }
      }
    }
    if (oldDirectory) { try { fs.rmSync(oldDirectory, { recursive: true, force: true }); } catch {} }
    if (cleanupPendingPid) rememberError(fault('WINDOWS_MCP_STOP_INCOMPLETE', 'Windows 控制进程尚未确认退出，请重启客户端后再启动。'));
    return !cleanupPendingPid;
  }
  async function bounded(job, operation, timeout) {
    const controller = new AbortController();
    job.controller = controller;
    const cancel = () => controller.abort(aborted());
    job.signal?.addEventListener('abort', cancel, { once: true });
    if (job.signal?.aborted) cancel();
    let timer, abortListener;
    const timeoutError = fault('WINDOWS_MCP_TIMEOUT', 'Windows 工具响应超时。');
    const deadline = new Promise((_, reject) => {
      abortListener = () => reject(controller.signal.reason || aborted());
      controller.signal.addEventListener('abort', abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
      timer = setTimeout(() => controller.abort(timeoutError), timeout);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return operation(controller.signal);
      }), deadline]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abortListener);
      job.signal?.removeEventListener('abort', cancel);
    }
  }
  async function listCatalog(signal) {
    const all = [], cursors = new Set();
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: requestTimeoutMs });
      if (!Array.isArray(page.tools) || all.length + page.tools.length > 200) throw fault('WINDOWS_MCP_PROTOCOL_INVALID', 'Windows 工具目录格式异常。');
      all.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw fault('WINDOWS_MCP_PROTOCOL_INVALID', 'Windows 工具目录分页异常。');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const names = new Set();
    catalog = all.filter(tool => Object.hasOwn(WINDOWS_MCP_TOOL_POLICY, tool.name)).map(tool => {
      if (names.has(tool.name) || tool.inputSchema?.type !== 'object') throw fault('WINDOWS_MCP_PROTOCOL_INVALID', 'Windows 工具目录格式异常。');
      names.add(tool.name);
      return exposeTool(tool);
    });
    if (!names.has('ControlStatus')) throw fault('WINDOWS_MCP_PROTOCOL_INVALID', 'Windows 工具目录缺少控制状态工具。');
    return clone(catalog);
  }
  async function run(job) {
    if (job.signal?.aborted) throw aborted();
    if (job.kind === 'start') {
      if (state === 'ready') return status();
      if (client || transport) await dispose();
      if (cleanupPendingPid) throw fault('WINDOWS_MCP_STOP_INCOMPLETE', '旧 Windows 控制进程尚未确认退出，请重启客户端。');
      if (platform !== 'win32') throw fault('WINDOWS_MCP_WINDOWS_REQUIRED', 'Windows MCP 只在 Windows 客户端运行。');
      state = 'starting'; lastError = null; notify();
      return bounded(job, async signal => {
        const sdk = await loadSdk();
        if (signal.aborted) throw signal.reason;
        const executable = resolveUvx();
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiwei-windows-mcp-'));
        const configPath = path.join(configDirectory, 'config.toml');
        fs.writeFileSync(configPath, '# Isolated Xiwei stdio configuration.\n', { mode: 0o600 });
        transport = new sdk.StdioClientTransport({ command: executable, args: ['--python', '3.14', '--from', `windows-mcp==${WINDOWS_MCP_VERSION}`, 'windows-mcp', 'serve', '--transport', 'stdio', '--config', configPath, '--tools', Object.keys(WINDOWS_MCP_TOOL_POLICY).join(',')],
          env: { ANONYMIZED_TELEMETRY: 'false', DO_NOT_TRACK: '1', WINDOWS_MCP_WATCHDOG: 'off', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' }, stderr: 'pipe', maxBufferSize: 16 * 1024 * 1024 });
        // Consume stderr without retaining potentially private application content.
        transport.stderr?.on('data', () => {});
        client = new sdk.Client({ name: 'xiwei-windows-client', version: '1.0.0' }, { capabilities: {} });
        const boundClient = client;
        client.onclose = () => {
          if (client !== boundClient || state === 'stopping' || state === 'stopped') return;
          state = 'failed';
          const error = fault('WINDOWS_MCP_DISCONNECTED', 'Windows 控制服务已退出。');
          active?.controller?.abort(error);
          rejectQueue(error); rememberError(error);
        };
        client.onerror = () => { if (client === boundClient) rememberError(fault('WINDOWS_MCP_TRANSPORT_ERROR', 'Windows 控制连接发生错误。')); };
        await client.connect(transport, { signal, timeout: startupTimeoutMs });
        if (signal.aborted) throw signal.reason;
        await listCatalog(signal);
        if (signal.aborted) throw signal.reason;
        state = 'ready'; startedAt = new Date().toISOString(); notify();
        return status();
      }, startupTimeoutMs);
    }
    if (state !== 'ready' || !client) throw unavailable();
    if (job.kind === 'list') return bounded(job, listCatalog, requestTimeoutMs);
    if (!catalog.some(tool => tool.name === job.tool)) throw fault('WINDOWS_MCP_TOOL_UNAVAILABLE', '当前 Windows 控制服务未提供此工具。');
    const before = performance.now();
    return bounded(job, async signal => {
      job.dispatched = true;
      const result = await client.callTool({ name: job.tool, arguments: job.args }, undefined, { signal, timeout: requestTimeoutMs });
      const normalized = normalizeResult(job.tool, result);
      if (normalized.errorCode) {
        rememberError(fault(normalized.errorCode, 'Windows 工具未完成；请查看工具返回的原因。'));
        if (normalized.outcomeUnknown || ['USER_CONTROL', 'TAKEOVER_PENDING', 'CONTROL_UNAVAILABLE', 'CONTROL_PREEMPTED'].includes(normalized.errorCode)) {
          rejectQueue(fault('WINDOWS_MCP_QUEUE_CANCELLED', 'Windows 控制权不可用或前一动作结果不明，后续操作已取消。'));
        }
      }
      return { tool: job.tool, access: WINDOWS_MCP_TOOL_POLICY[job.tool], durationMs: Math.round((performance.now() - before) * 10) / 10, ...normalized };
    }, requestTimeoutMs);
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !stopping) {
        const job = queue.shift();
        job.signal?.removeEventListener('abort', job.abortQueued);
        active = job; notify();
        try { job.resolve(await run(job)); }
        catch (cause) {
          // Each caller owns its error. Do not mutate the shared stop/exit reason
          // used by queued requests that definitely have not been dispatched.
          const error = cause instanceof WindowsMcpError ? fault(cause.code, cause.message) : fault('WINDOWS_MCP_FAILED', 'Windows 工具调用失败，请检查客户端环境。');
          error.outcomeUnknown = job.dispatched === true && WINDOWS_MCP_TOOL_POLICY[job.tool] === 'write';
          if (job.tool) error.tool = job.tool;
          // A cancelled/timed-out input may have happened. Retire this connection;
          // no queued operation or automatic retry may follow an uncertain action.
          if (job.kind === 'start' || job.kind === 'list' && client || job.dispatched || ['WINDOWS_MCP_TIMEOUT', 'WINDOWS_MCP_CANCELLED'].includes(error.code)) {
            if (state !== 'stopping') state = 'failed';
            rejectQueue(fault('WINDOWS_MCP_QUEUE_CANCELLED', '前一操作未完成，后续 Windows 操作已取消。'));
            await dispose();
          }
          if (!cleanupPendingPid) rememberError(error);
          job.reject(error);
        } finally { active = null; notify(); }
      }
    } finally { draining = false; }
  }
  function enqueue(kind, tool, args, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(aborted());
    if (stopping) return Promise.reject(fault('WINDOWS_MCP_STOPPING', 'Windows 控制服务正在停止。'));
    if (queue.length >= 20) return Promise.reject(fault('WINDOWS_MCP_QUEUE_FULL', 'Windows 操作队列已满。'));
    return new Promise((resolve, reject) => {
      const job = { kind, tool, args, signal, resolve, reject, dispatched: false };
      job.abortQueued = () => { const i = queue.indexOf(job); if (i >= 0) { queue.splice(i, 1); reject(aborted()); notify(); } };
      signal?.addEventListener('abort', job.abortQueued, { once: true });
      queue.push(job); void drain();
    });
  }
  async function stop() {
    if (stopping) return stopping;
    state = 'stopping'; notify();
    const error = fault('WINDOWS_MCP_STOPPED', 'Windows 控制服务已停止。');
    rejectQueue(error); active?.controller?.abort(error);
    stopping = (async () => {
      const closed = await dispose();
      // The active request also observes abort and retires its resources.
      while (draining) await new Promise(resolve => setTimeout(resolve, 5));
      state = closed && !cleanupPendingPid ? 'stopped' : 'failed'; notify();
      return status();
    })();
    try { return await stopping; } finally { stopping = null; }
  }
  return Object.freeze({
    start: options => enqueue('start', null, null, options),
    listTools: options => enqueue('list', null, null, options),
    callTool(name, args = {}, options) { try { return enqueue('call', name, validateArguments(name, args), options); } catch (error) { return Promise.reject(error); } },
    stop, status,
  });
}

module.exports = { createWindowsMcpClient, WindowsMcpError, WINDOWS_MCP_VERSION, WINDOWS_MCP_TOOL_POLICY };
