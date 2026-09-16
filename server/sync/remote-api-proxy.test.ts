import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalDeviceRoute } from './remote-api-proxy.js';

test('客户端只在本机处理设备配置、健康检查和上传状态', () => {
  for (const path of ['/api/health', '/api/settings', '/api/sync/status', '/api/sync/run']) assert.equal(isLocalDeviceRoute(path), true, path);
  for (const path of ['/api/home', '/api/projects', '/api/knowledge/documents', '/api/memories', '/api/conversations', '/api/chat/stream', '/api/releases/latest', '/api/skills']) assert.equal(isLocalDeviceRoute(path), false, path);
});
