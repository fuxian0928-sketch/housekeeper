'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createWindowsMcpClient, WINDOWS_MCP_VERSION, WINDOWS_MCP_TOOL_POLICY } = require('../electron/windows-mcp-client.cjs');

function fixture(overrides = {}) {
  const calls = [], transports = [], clients = [];
  let params;
  class Transport {
    constructor(value) { params = value; this.stderr = new PassThrough(); this.pid = 12345; transports.push(this); }
    async close() { this.pid = null; }
  }
  class Client {
    constructor() { clients.push(this); }
    async connect(transport, options) { this.transport = transport; calls.push('connect'); if (overrides.connect) await overrides.connect(options); }
    async listTools() { return { tools: [
      ...Object.keys(WINDOWS_MCP_TOOL_POLICY).map(name => ({ name, description: name, inputSchema: { type: 'object', properties: name === 'ControlStatus' ? {} : { text: { type: 'string' }, executable: { type: 'string' }, name: { type: 'string' }, mode: { type: 'string' }, use_vision: { anyOf: [{ type: 'boolean' }, { type: 'string' }] } } }, annotations: { readOnlyHint: true } })),
      { name: 'PowerShell', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    ] }; }
    async callTool(params, _, options) { calls.push(params); return overrides.call ? overrides.call(params, options) : { content: [{ type: 'text', text: 'ok' }] }; }
    async close() { calls.push('close'); if (overrides.close) return overrides.close(); await this.transport?.close(); this.onclose?.(); }
  }
  const client = createWindowsMcpClient({ platform: 'win32', loadSdk: async () => ({ Client, StdioClientTransport: Transport }), startupTimeoutMs: 1000, requestTimeoutMs: 1000, shutdownTimeoutMs: 100, ...overrides.options });
  return { client, calls, transports, clients, params: () => params };
}

test('Windows-only; fixed package, stdio, isolated config and no general execution tool', async t => {
  const unsupported = createWindowsMcpClient({ platform: 'linux' });
  await assert.rejects(unsupported.start(), { code: 'WINDOWS_MCP_WINDOWS_REQUIRED' });
  const f = fixture(); t.after(() => f.client.stop());
  await f.client.start();
  assert.equal(WINDOWS_MCP_VERSION, '0.8.8');
  const p = f.params();
  assert.ok(p.args.includes('windows-mcp==0.8.8'));
  assert.deepEqual(p.args.slice(0, 6), ['--python', '3.14', '--from', 'windows-mcp==0.8.8', 'windows-mcp', 'serve']);
  assert.equal(p.args[p.args.indexOf('--transport') + 1], 'stdio');
  assert.ok(p.args.includes('--config'));
  assert.equal(p.env.ANONYMIZED_TELEMETRY, 'false');
  assert.equal(p.env.WINDOWS_MCP_WATCHDOG, 'off');
  const tools = await f.client.listTools();
  assert.equal(tools.some(tool => tool.name === 'PowerShell'), false);
  assert.equal(tools.find(tool => tool.name === 'Type').readOnly, false);
  assert.equal(tools.find(tool => tool.name === 'Snapshot').access, 'read');
  assert.deepEqual(tools.find(tool => tool.name === 'Snapshot').inputSchema.properties.use_vision, { type: 'boolean' });
  assert.equal(tools.find(tool => tool.name === 'App').inputSchema.properties.executable, undefined);
  assert.deepEqual(tools.find(tool => tool.name === 'App').inputSchema.properties.mode.enum, ['launch', 'switch', 'resize']);
});

test('local policy rejects command modes, unknown fields, terminal launches and forbidden shortcuts before dispatch', async t => {
  const f = fixture(); t.after(() => f.client.stop()); await f.client.start();
  for (const [name, args] of [
    ['PowerShell', { command: 'whoami' }], ['Registry', {}], ['Process', {}], ['FileSystem', {}],
    ['App', { mode: 'launch_executable', executable: 'x.exe' }], ['App', { name: 'powershell' }],
    ['App', { name: 'notepad', args: ['private.txt'] }], ['Shortcut', { shortcut: 'win+r' }],
    ['Shortcut', { shortcut: 'ctrl+shift+esc' }], ['Type', { loc: [10, 10], text: 'x', clear: 'true' }],
    ['Type', { loc: [10, 10], text: 'x', arbitrary: 1 }], ['Move', { loc: [10, 10], duration: 2 }],
  ]) await assert.rejects(f.client.callTool(name, args), error => /^WINDOWS_MCP_(TOOL_BLOCKED|ARGUMENTS_INVALID)$/.test(error.code));
  assert.equal(f.calls.filter(call => typeof call === 'object').length, 0);
  const result = await f.client.callTool('App', { name: 'notepad' });
  assert.equal(result.access, 'write');
  assert.equal(f.calls.at(-1).arguments.mode, 'launch');
});

test('requests are serial, queued arguments cannot be changed and queued cancellation never dispatches', async t => {
  let release;
  const f = fixture({ call: async params => { if (params.name === 'Click') await new Promise(resolve => { release = resolve; }); return { content: [] }; } });
  t.after(() => f.client.stop()); await f.client.start();
  const first = f.client.callTool('Click', { loc: [1, 2] });
  const args = { text: 'safe', loc: [3, 4] };
  const second = f.client.callTool('Type', args); args.text = 'mutated'; args.loc[0] = 999;
  const controller = new AbortController();
  const cancelled = f.client.callTool('ControlStatus', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { code: 'WINDOWS_MCP_CANCELLED', outcomeUnknown: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => typeof call === 'object').length, 1);
  release(); await first; await second;
  assert.deepEqual(f.calls.filter(call => typeof call === 'object').map(call => call.name), ['Click', 'Type']);
  assert.deepEqual(f.calls.at(-1).arguments, { text: 'safe', loc: [3, 4] });
});

test('timed-out action is never retried and cancels later requests with unknown outcome', async t => {
  const f = fixture({ call: () => new Promise(() => {}), options: { requestTimeoutMs: 25 } });
  t.after(() => f.client.stop()); await f.client.start();
  const first = f.client.callTool('Type', { text: 'single', loc: [1, 2] });
  const later = f.client.callTool('Click', { loc: [2, 3] });
  const observedLater = assert.rejects(later, { code: 'WINDOWS_MCP_QUEUE_CANCELLED', outcomeUnknown: false });
  await assert.rejects(first, { code: 'WINDOWS_MCP_TIMEOUT', outcomeUnknown: true, tool: 'Type' });
  await observedLater;
  assert.equal(f.client.status().state, 'failed');
  assert.equal(f.transports[0].pid, null);
  assert.equal(f.calls.filter(call => typeof call === 'object').length, 1);
  await assert.rejects(f.client.callTool('ControlStatus'), { code: 'WINDOWS_MCP_NOT_READY' });
});

test('active cancellation closes the connection; an explicit later start creates a new instance', async t => {
  const controller = new AbortController();
  const f = fixture({ call: () => new Promise(() => {}) });
  t.after(() => f.client.stop()); await f.client.start();
  const first = f.client.callTool('Click', { loc: [1, 2] }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(first, { code: 'WINDOWS_MCP_CANCELLED', outcomeUnknown: true });
  assert.equal(f.client.status().state, 'failed');
  await f.client.start();
  f.clients[0].onclose(); // A late old-process event must not poison the new instance.
  assert.equal(f.client.status().state, 'ready');
  assert.equal(f.transports.length, 2);
});

test('stop aborts an active request, drains pending work and is idempotent', async () => {
  const f = fixture({ call: () => new Promise(() => {}) }); await f.client.start();
  const active = f.client.callTool('Type', { text: 'safe', loc: [1, 2] });
  const observedActive = assert.rejects(active, { code: 'WINDOWS_MCP_STOPPED', outcomeUnknown: true });
  await new Promise(resolve => setImmediate(resolve));
  const queued = f.client.callTool('ControlStatus');
  const observedQueued = assert.rejects(queued, { code: 'WINDOWS_MCP_STOPPED', outcomeUnknown: false });
  await Promise.all([f.client.stop(), f.client.stop(), observedActive, observedQueued]);
  assert.equal(f.client.status().state, 'stopped');
  assert.equal(f.client.status().pid, null);
  assert.equal(f.calls.filter(call => call === 'close').length, 1);
});

test('unexpected process exit fails active action without retry and invalidates queued work', async t => {
  const f = fixture({ call: () => new Promise(() => {}) }); t.after(() => f.client.stop()); await f.client.start();
  const active = f.client.callTool('Click', { loc: [1, 2] });
  const observed = assert.rejects(active, { code: 'WINDOWS_MCP_DISCONNECTED', outcomeUnknown: true });
  const queued = f.client.callTool('ControlStatus');
  let queuedError;
  const queuedObserved = queued.catch(error => { queuedError = error; });
  await new Promise(resolve => setImmediate(resolve)); f.clients[0].onclose(); await observed;
  await queuedObserved;
  assert.equal(queuedError.code, 'WINDOWS_MCP_DISCONNECTED');
  assert.equal(queuedError.outcomeUnknown, false);
  assert.equal(f.client.status().state, 'failed');
  assert.equal(f.calls.filter(call => typeof call === 'object').length, 1);
});

test('startup deadline and cancellation remain bounded even when dependency loading stalls', async () => {
  const client = createWindowsMcpClient({ platform: 'win32', startupTimeoutMs: 20, loadSdk: () => new Promise(() => {}) });
  await assert.rejects(client.start(), { code: 'WINDOWS_MCP_TIMEOUT', outcomeUnknown: false });
  assert.equal(client.status().state, 'failed'); await client.stop();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.start({ signal: controller.signal }), { code: 'WINDOWS_MCP_CANCELLED' });
  assert.equal(client.status().state, 'stopped');
});

test('cross-context plain objects work but unknown executable and type confusion remain rejected', async t => {
  const f = fixture(); t.after(() => f.client.stop()); await f.client.start();
  const vm = require('node:vm');
  const args = vm.runInNewContext('({text:"cross-context",loc:[2,3]})');
  await f.client.callTool('Type', args);
  assert.deepEqual(f.calls.at(-1).arguments, { text: 'cross-context', loc: [2, 3] });
  await assert.rejects(f.client.callTool('Snapshot', { use_vision: 'false' }), { code: 'WINDOWS_MCP_ARGUMENTS_INVALID' });
});

test('known upstream false-success messages become errors without retry', async t => {
  const f = fixture({ call: async () => ({ content: [{ type: 'text', text: 'Notepad not found in start menu.' }], isError: false }) });
  t.after(() => f.client.stop()); await f.client.start();
  const output = await f.client.callTool('App', { name: 'notepad' });
  assert.equal(output.result.isError, true);
  assert.equal(output.errorCode, 'WINDOWS_MCP_APP_NOT_FOUND');
  assert.equal(output.outcomeUnknown, false);
  assert.equal(f.client.status().lastError.code, 'WINDOWS_MCP_APP_NOT_FOUND');
  assert.equal(f.calls.filter(call => typeof call === 'object').length, 1);
});

test('user-control rejection cancels pending actions and preserves the healthy connection for explicit later requests', async t => {
  let release;
  const f = fixture({ call: async () => {
    await new Promise(resolve => { release = resolve; });
    return { content: [{ type: 'text', text: '{"code":"USER_CONTROL","status":{"state":"user","wait_seconds":10}}' }], isError: true };
  } });
  t.after(() => f.client.stop()); await f.client.start();
  const active = f.client.callTool('App', { name: 'notepad' });
  const queued = f.client.callTool('Click', { loc: [1, 2] });
  const observed = assert.rejects(queued, { code: 'WINDOWS_MCP_QUEUE_CANCELLED' });
  await new Promise(resolve => setImmediate(resolve)); release();
  const output = await active; await observed;
  assert.equal(output.errorCode, 'USER_CONTROL');
  assert.equal(output.outcomeUnknown, false);
  assert.equal(f.client.status().state, 'ready');
  assert.equal(f.client.status().lastError.code, 'USER_CONTROL');
  assert.equal(f.calls.filter(call => typeof call === 'object').length, 1);
});

test('unconfirmed shutdown is reported and blocks a second process instead of claiming success', async () => {
  const f = fixture({ close: () => new Promise(() => {}), options: { shutdownTimeoutMs: 20 } });
  await f.client.start();
  const status = await f.client.stop();
  assert.equal(status.state, 'failed');
  assert.equal(status.cleanupPending, true);
  assert.equal(status.pid, 12345);
  assert.equal(status.lastError.code, 'WINDOWS_MCP_STOP_INCOMPLETE');
  await assert.rejects(f.client.start(), { code: 'WINDOWS_MCP_STOP_INCOMPLETE' });
});
