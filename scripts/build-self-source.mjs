import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const hash = text => createHash('sha256').update(text).digest('hex');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isSymbolicLink() ? [] : item.isDirectory() ? walk(join(dir, item.name)) : [join(dir, item.name)]).sort();
}
// Fixed code-only roots. No vault, database, configuration, logs or arbitrary path input.
const files = ['src', 'server'].flatMap(dir => walk(join(root, dir)))
  .filter(path => /\.(tsx?|css)$/.test(path) && !/\.test\.tsx?$/.test(path))
  .map(path => {
    const content = readFileSync(path, 'utf8');
    if (/(?:sk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(content)) throw new Error(`Credential-like literal in ${relative(root, path)}; refusing source snapshot`);
    return { path: relative(root, path).replaceAll('\\', '/'), content, sha256: hash(content) };
  });
const artifacts = walk(join(root, 'build/server')).filter(path => path.endsWith('.js') && !path.endsWith('.test.js'))
  .map(path => ({ path: relative(join(root, 'build/server'), path).replaceAll('\\', '/'), sha256: hash(readFileSync(path)) }));
let commit = null;
let dirty = true;
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--', 'src', 'server', 'package.json'], { cwd: root, encoding: 'utf8' }).trim()); } catch { /* Builds without git still have content identities. */ }
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const buildId = hash(JSON.stringify({ version, files: files.map(({path,sha256})=>({path,sha256})), artifacts }));
mkdirSync(join(root, 'build/server'), { recursive: true });
writeFileSync(join(root, 'build/server/self-source.json'), JSON.stringify({ format: 1, version, buildId, commit, dirty, builtAt: new Date().toISOString(), artifacts, files }));
console.log(`Self source snapshot: ${files.length} files, build ${buildId.slice(0,12)}`);
