import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

function normalized(value: string) { return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); }
function withoutMarkdown(value: string) { return value.replace(/\.md$/i, ''); }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function sha256(value: string) { return createHash('sha256').update(value).digest('hex'); }

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    if (entry.name === '.obsidian' || entry.name === '.trash') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectMarkdownFiles(path);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [path] : [];
  }));
  return nested.flat();
}

function rewriteLinks(content: string, oldRelativePath: string, newRelativePath: string) {
  const oldPath = withoutMarkdown(normalized(oldRelativePath));
  const newPath = withoutMarkdown(normalized(newRelativePath));
  const oldName = withoutMarkdown(basename(oldRelativePath));
  const newName = withoutMarkdown(basename(newRelativePath));
  let updated = content;
  updated = updated.replace(new RegExp(`(!?\\[\\[)${escapeRegExp(oldPath)}(?=([#|]|\\]\\]))`, 'g'), `$1${newPath}`);
  if (oldName !== oldPath) updated = updated.replace(new RegExp(`(!?\\[\\[)${escapeRegExp(oldName)}(?=([#|]|\\]\\]))`, 'g'), `$1${newName}`);
  updated = updated.replaceAll(`](${normalized(oldRelativePath)})`, `](${normalized(newRelativePath)})`);
  updated = updated.replaceAll(`](<${normalized(oldRelativePath)}>)`, `](<${normalized(newRelativePath)}>)`);
  return updated;
}

export interface InboundLinkChange { relativePath: string; originalContent: string; updatedContent: string }

export async function inspectInboundLinks(vaultPath: string, oldRelativePath: string, newRelativePath: string) {
  const files = await collectMarkdownFiles(resolve(vaultPath));
  const changes: InboundLinkChange[] = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const updatedContent = rewriteLinks(content, oldRelativePath, newRelativePath);
    if (updatedContent !== content) changes.push({ relativePath: normalized(relative(vaultPath, file)), originalContent: content, updatedContent });
  }
  return changes;
}

async function atomicWrite(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function moveDocumentWithLinks(input: { vaultPath: string; sourceRelativePath: string; destinationRelativePath: string; expectedHash: string; backupDirectory: string }) {
  const vault = resolve(input.vaultPath);
  const source = resolve(vault, normalized(input.sourceRelativePath));
  const destination = resolve(vault, normalized(input.destinationRelativePath));
  const currentContent = await readFile(source, 'utf8');
  if (sha256(currentContent) !== input.expectedHash) throw new Error('源文档在确认后发生了变化，请重新生成移动预览。');
  try { await stat(destination); throw new Error('目标路径已经存在，不会覆盖同名文档。'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const linkChanges = await inspectInboundLinks(vault, input.sourceRelativePath, input.destinationRelativePath);
  const operationBackup = join(input.backupDirectory, randomUUID());
  await mkdir(operationBackup, { recursive: true });
  await copyFile(source, join(operationBackup, 'source.md'));
  for (const change of linkChanges) {
    const backup = join(operationBackup, 'links', change.relativePath);
    await mkdir(dirname(backup), { recursive: true });
    await writeFile(backup, change.originalContent, 'utf8');
  }
  await mkdir(dirname(destination), { recursive: true });
  let moved = false;
  const written: InboundLinkChange[] = [];
  try {
    await rename(source, destination);
    moved = true;
    for (const change of linkChanges) {
      const path = change.relativePath === normalized(input.sourceRelativePath) ? destination : resolve(vault, change.relativePath);
      await atomicWrite(path, change.updatedContent);
      written.push(change);
    }
    const verified = await readFile(destination, 'utf8');
    if (!verified.length && currentContent.length) throw new Error('移动后的文档内容校验失败。');
  } catch (error) {
    for (const change of written.toReversed()) {
      const path = change.relativePath === normalized(input.sourceRelativePath) ? destination : resolve(vault, change.relativePath);
      await atomicWrite(path, change.originalContent).catch(() => undefined);
    }
    if (moved) await rename(destination, source).catch(() => undefined);
    throw error;
  }
  return { destinationRelativePath: normalized(input.destinationRelativePath), affectedLinks: linkChanges.map((change) => change.relativePath), backupPath: operationBackup };
}
