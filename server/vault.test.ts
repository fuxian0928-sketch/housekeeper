import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkMarkdown } from './vault.js';

test('Markdown 切分保留标题层级、行号和相邻位置', () => {
  const markdown = `---
type: project
---
# AI 秘书

项目背景说明。

## 检索

检索方案正文。

## 记忆

记忆方案正文。`;
  const chunks = chunkMarkdown(markdown);

  assert.equal(chunks.length, 4);
  assert.equal(chunks[1].headingPath, 'AI 秘书');
  assert.equal(chunks[2].headingPath, 'AI 秘书 > 检索');
  assert.equal(chunks[2].startLine, 10);
  assert.equal(chunks[2].endLine, 10);
  assert.equal(chunks[2].metadata.previousPosition, 1);
  assert.equal(chunks[2].metadata.nextPosition, 3);
});

test('代码块、表格和 Obsidian callout 不会被拆散', () => {
  const markdown = `# 技术方案

\`\`\`ts
const answer = 42;
\`\`\`

| 层面 | 做法 |
|---|---|
| 检索 | 混合召回 |

> [!note] 说明
> 这是一个完整的 callout。`;
  const chunks = chunkMarkdown(markdown);

  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.metadata.nodeTypes), [['code'], ['table'], ['blockquote']]);
  assert.ok(chunks.every((chunk) => chunk.metadata.atomic));
  assert.match(chunks[1].content, /\| 检索\s+\| 混合召回/);
  assert.match(chunks[2].content, /\[!note\]/);
});

test('普通段落按目标大小合并并在上限前切分', () => {
  const paragraph = `${'这是用于验证切分边界的中文内容。'.repeat(34)}`;
  const chunks = chunkMarkdown(`# 长文\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`);

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.tokenCount <= 600));
});

test('GFM 删除线文档可以完整切分', () => {
  const chunks = chunkMarkdown('# 版本记录\n\n当前方案保留，~~旧方案已经废弃~~，后续不再执行。');
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /~~旧方案已经废弃~~/);
});
