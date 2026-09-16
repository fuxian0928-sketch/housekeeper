import { createHash } from 'node:crypto';
import { database, nowIso } from '../../db.js';

const githubApi = 'https://api.github.com';
const maxFileBytes = 400_000;
const maxTreeEntries = 2_000;

export interface GitHubLocation {
  owner: string;
  repository: string;
  ref: string | null;
  path: string;
}

function requestHeaders() {
  return { Accept: 'application/vnd.github+json', 'User-Agent': 'AI-Secretary-Local' };
}

export function parseGitHubUrl(value: string): GitHubLocation {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw Object.assign(new Error('请输入完整的 GitHub 地址。'), { statusCode: 400 }); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') throw Object.assign(new Error('目前只允许读取 github.com 的 HTTPS 地址。'), { statusCode: 400 });
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) throw Object.assign(new Error('GitHub 仓库地址不完整。'), { statusCode: 400 });
  const marker = parts[2];
  return {
    owner: parts[0],
    repository: parts[1].replace(/\.git$/i, ''),
    ref: marker === 'tree' || marker === 'blob' ? parts[3] ?? null : null,
    path: marker === 'tree' || marker === 'blob' ? parts.slice(4).join('/') : ''
  };
}

async function githubJson<T>(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { headers: requestHeaders(), signal, redirect: 'error' });
  if (!response.ok) {
    const message = response.status === 404 ? '仓库或文件不存在，也可能是私有仓库。' : `GitHub 返回 ${response.status}。`;
    throw Object.assign(new Error(message), { statusCode: response.status === 404 ? 404 : 502 });
  }
  return response.json() as Promise<T>;
}

export async function inspectGitHubRepository(repositoryUrl: string, signal?: AbortSignal) {
  const location = parseGitHubUrl(repositoryUrl);
  const repository = await githubJson<{ full_name: string; description: string | null; default_branch: string; stargazers_count: number; updated_at: string; html_url: string; size: number }>(`${githubApi}/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}`, signal);
  const ref = location.ref ?? repository.default_branch;
  const tree = await githubJson<{ truncated: boolean; tree: Array<{ path: string; type: 'blob' | 'tree'; size?: number; sha: string }> }>(`${githubApi}/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}/git/trees/${encodeURIComponent(ref)}?recursive=1`, signal);
  const prefix = location.path.replace(/^\/+|\/+$/g, '');
  const entries = tree.tree.filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`)).slice(0, maxTreeEntries);
  return {
    repository: repository.full_name,
    repositoryUrl: repository.html_url,
    description: repository.description ?? '',
    defaultBranch: repository.default_branch,
    ref,
    path: prefix,
    stars: repository.stargazers_count,
    updatedAt: repository.updated_at,
    sizeKb: repository.size,
    truncated: tree.truncated || tree.tree.length > maxTreeEntries,
    entries
  };
}

export async function readGitHubFile(repositoryUrl: string, requestedPath?: string, signal?: AbortSignal) {
  const inspected = await inspectGitHubRepository(repositoryUrl, signal);
  const path = (requestedPath?.trim() || inspected.path).replace(/^\/+/, '');
  if (!path || path.includes('..')) throw Object.assign(new Error('请指定仓库内的文件路径。'), { statusCode: 400 });
  const entry = inspected.entries.find((candidate) => candidate.type === 'blob' && candidate.path === path);
  if (!entry) throw Object.assign(new Error('指定文件不在仓库中。'), { statusCode: 404 });
  if ((entry.size ?? 0) > maxFileBytes) throw Object.assign(new Error('文件过大，当前只读取 400 KB 以内的文本文件。'), { statusCode: 413 });
  const location = parseGitHubUrl(repositoryUrl);
  const response = await fetch(`https://raw.githubusercontent.com/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}/${encodeURIComponent(inspected.ref)}/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: { 'User-Agent': 'AI-Secretary-Local' }, signal, redirect: 'error' });
  if (!response.ok) throw Object.assign(new Error('GitHub 文件读取失败。'), { statusCode: response.status === 404 ? 404 : 502 });
  const content = await response.text();
  if (Buffer.byteLength(content, 'utf8') > maxFileBytes || content.includes('\0')) throw Object.assign(new Error('该文件不是可安全读取的普通文本。'), { statusCode: 415 });
  const checksum = createHash('sha256').update(content).digest('hex');
  const repoKey = inspected.repository.toLowerCase();
  database.prepare(`INSERT INTO github_repo_cache (repo_key, ref, path, repository_url, checksum, content, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_key, ref, path) DO UPDATE SET repository_url = excluded.repository_url, checksum = excluded.checksum, content = excluded.content, fetched_at = excluded.fetched_at`).run(repoKey, inspected.ref, path, inspected.repositoryUrl, checksum, content, nowIso());
  return { repository: inspected.repository, repositoryUrl: inspected.repositoryUrl, ref: inspected.ref, path, checksum, content };
}

export async function readGitHubDirectory(repositoryUrl: string, signal?: AbortSignal) {
  const inspected = await inspectGitHubRepository(repositoryUrl, signal);
  const location = parseGitHubUrl(repositoryUrl);
  const prefix = inspected.path ? `${inspected.path.replace(/\/+$/, '')}/` : '';
  const files = inspected.entries.filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix));
  if (!files.some((entry) => entry.path === `${prefix}SKILL.md`)) throw Object.assign(new Error('这个目录里没有 SKILL.md，不能作为技能安装。'), { statusCode: 400 });
  if (files.length > 40 || files.reduce((sum, entry) => sum + (entry.size ?? 0), 0) > 2_000_000) throw Object.assign(new Error('技能目录过大；基础版本最多安装 40 个文件、合计 2 MB。'), { statusCode: 413 });
  const contents = await Promise.all(files.map(async (entry) => {
    if ((entry.size ?? 0) > maxFileBytes) throw Object.assign(new Error(`文件 ${entry.path} 超过 400 KB。`), { statusCode: 413 });
    const response = await fetch(`https://raw.githubusercontent.com/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}/${encodeURIComponent(inspected.ref)}/${entry.path.split('/').map(encodeURIComponent).join('/')}`, { headers: { 'User-Agent': 'AI-Secretary-Local' }, signal, redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error(`文件 ${entry.path} 下载失败。`), { statusCode: 502 });
    const content = await response.text();
    if (content.includes('\0')) throw Object.assign(new Error(`文件 ${entry.path} 不是普通文本，基础版本暂不安装。`), { statusCode: 415 });
    return { path: entry.path.slice(prefix.length), content, checksum: createHash('sha256').update(content).digest('hex') };
  }));
  return { ...inspected, files: contents };
}
