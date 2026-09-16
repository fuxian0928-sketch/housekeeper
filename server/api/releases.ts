import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Express } from 'express';

type ReleaseManifest = {
  version: string;
  filename: string;
  sha256: string;
  size: number;
  publishedAt: string;
};

function releaseDirectory() {
  return resolve(process.env.AI_SECRETARY_RELEASE_DIRECTORY?.trim() || join(process.cwd(), 'releases'));
}

function currentRelease(): { manifest: ReleaseManifest; installerPath: string } | null {
  const directory = releaseDirectory();
  const manifestPath = join(directory, 'latest.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest;
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || basename(manifest.filename) !== manifest.filename || !/\.exe$/i.test(manifest.filename)) return null;
  const installerPath = join(directory, manifest.filename);
  if (!existsSync(installerPath)) return null;
  const stats = statSync(installerPath);
  if (!stats.isFile() || stats.size !== manifest.size) return null;
  if (!/^[A-Fa-f0-9]{64}$/.test(manifest.sha256)) return null;
  return { manifest: { ...manifest, sha256: manifest.sha256.toUpperCase() }, installerPath };
}

export function registerReleaseRoutes(app: Express) {
  app.get('/api/releases/latest', (_request, response) => {
    try {
      const release = currentRelease();
      if (!release) { response.status(404).json({ message: '服务器暂时没有可下载的客户端版本。' }); return; }
      response.json({ ...release.manifest, downloadUrl: '/api/releases/download' });
    } catch {
      response.status(500).json({ message: '服务器版本信息无效，请重新发布安装包。' });
    }
  });

  app.get('/api/releases/download', (_request, response) => {
    try {
      const release = currentRelease();
      if (!release) { response.status(404).json({ message: '服务器暂时没有可下载的客户端版本。' }); return; }
      response.setHeader('X-Checksum-SHA256', release.manifest.sha256);
      response.download(release.installerPath, release.manifest.filename);
    } catch {
      response.status(500).json({ message: '安装包读取失败，请重新发布后再试。' });
    }
  });
}
