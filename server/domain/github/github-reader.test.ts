import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('只接受 github.com HTTPS 仓库地址并解析技能目录', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-secretary-github-test-'));
  process.env.AI_SECRETARY_DB_PATH = join(directory, 'github.db');
  const { database } = await import('../../db.js');
  const { parseGitHubUrl } = await import('./github-reader.js');
  context.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.deepEqual(parseGitHubUrl('https://github.com/openai/skills/tree/main/skills/docs'), {
    owner: 'openai', repository: 'skills', ref: 'main', path: 'skills/docs'
  });
  assert.throws(() => parseGitHubUrl('http://github.com/openai/skills'), /只允许读取/);
  assert.throws(() => parseGitHubUrl('https://example.com/openai/skills'), /只允许读取/);
});
