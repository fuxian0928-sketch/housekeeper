import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectInboundLinks, moveDocumentWithLinks } from './document-service.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

test('移动文档时同步更新 Wikilink 和 Markdown 入站链接', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'ai-secretary-vault-'));
  try {
    await mkdir(join(vault, '.obsidian'));
    await mkdir(join(vault, '旧目录'));
    await mkdir(join(vault, '引用'));
    const sourceContent = '# 原方案\n\n正文';
    await writeFile(join(vault, '旧目录', '原方案.md'), sourceContent, 'utf8');
    await writeFile(join(vault, '引用', '索引.md'), '参见 [[旧目录/原方案|方案]]、[[原方案]] 和 [原文](旧目录/原方案.md)。', 'utf8');
    const preview = await inspectInboundLinks(vault, '旧目录/原方案.md', '新目录/新方案.md');
    assert.deepEqual(preview.map((item) => item.relativePath), ['引用/索引.md']);
    const result = await moveDocumentWithLinks({ vaultPath: vault, sourceRelativePath: '旧目录/原方案.md', destinationRelativePath: '新目录/新方案.md', expectedHash: hash(sourceContent), backupDirectory: join(vault, '.backups') });
    assert.equal(await readFile(join(vault, '新目录', '新方案.md'), 'utf8'), sourceContent);
    const links = await readFile(join(vault, '引用', '索引.md'), 'utf8');
    assert.match(links, /\[\[新目录\/新方案\|方案\]\]/);
    assert.match(links, /\[\[新方案\]\]/);
    assert.match(links, /\(新目录\/新方案\.md\)/);
    assert.deepEqual(result.affectedLinks, ['引用/索引.md']);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('确认后源文档变化会阻止移动', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'ai-secretary-vault-'));
  try {
    await mkdir(join(vault, '目录'));
    await writeFile(join(vault, '目录', '文档.md'), '新内容', 'utf8');
    await assert.rejects(() => moveDocumentWithLinks({ vaultPath: vault, sourceRelativePath: '目录/文档.md', destinationRelativePath: '目录/新文档.md', expectedHash: hash('旧内容'), backupDirectory: join(vault, '.backups') }), /发生了变化/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});
