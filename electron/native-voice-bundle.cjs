const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

// An x64 installed copy may lack these ARM-only pip/setuptools launchers.
// They are never used by the sealed x64 voice worker. If present, they must
// still match the manifest; every other listed file remains mandatory.
const optionalArmLaunchers = new Set([
  'python/lib/site-packages/pip/_vendor/distlib/t64-arm.exe',
  'python/lib/site-packages/pip/_vendor/distlib/w64-arm.exe',
  'python/lib/site-packages/setuptools/cli-arm64.exe',
  'python/lib/site-packages/setuptools/gui-arm64.exe',
]);

// Internal app-owned resource path only. Never accept a renderer-provided root.
async function verifyNativeVoiceBundle(root) {
  try {
    const resolved = await fs.promises.realpath(root);
    const manifestFile = path.join(resolved, 'bundle.json');
    if ((await fs.promises.stat(manifestFile)).size > 8 * 1024 * 1024) throw Error();
    const manifest = JSON.parse(await fs.promises.readFile(manifestFile, 'utf8'));
    if (manifest.schema !== 1 || manifest.platform !== 'win32-x64' || manifest.python !== 'python/python.exe' || manifest.model !== 'model' || manifest.keywords !== 'keywords.txt' || !Array.isArray(manifest.files) || manifest.files.length > 20000) throw Error();
    const names = new Set(); let total = 0;
    for (const item of manifest.files) {
      if (typeof item.path !== 'string' || item.path.includes('\\') || item.path.includes(':') || item.path.startsWith('/') || item.path.split('/').some(part => !part || part === '.' || part === '..') || item.path === 'bundle.json' || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 512 * 1024 * 1024) throw Error();
      const key = item.path.toLowerCase();
      if (names.has(key)) throw Error(); names.add(key);
      total += item.bytes; if (total > 3 * 1024 * 1024 * 1024) throw Error();
    }
    // Check every manifest entry before I/O, then hash with a bounded number of
    // open handles. Thousands of tiny Python files must not queue serially on
    // cold startup. Every call still performs a complete, fresh verification.
    async function verifyFile(item) {
      const key = item.path.toLowerCase();
      const file = path.join(resolved, item.path);
      let real;
      try { real = await fs.promises.realpath(file); }
      catch (error) {
        if (error?.code === 'ENOENT' && optionalArmLaunchers.has(key)) return;
        throw error;
      }
      const relative = path.relative(resolved, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error();
      const handle = await fs.promises.open(file, 'r');
      try {
        const stat = await handle.stat(); if (!stat.isFile() || stat.size !== item.bytes) throw Error();
        const hash = createHash('sha256'); let bytes = 0;
        for await (const chunk of handle.createReadStream({autoClose:false})) { bytes += chunk.length; if (bytes > item.bytes) throw Error(); hash.update(chunk); }
        if (bytes !== item.bytes || hash.digest('hex') !== item.sha256) throw Error();
      } finally { await handle.close(); }
    }
    let cursor = 0, failed = false;
    const checks = await Promise.allSettled(Array.from({length:Math.min(8, manifest.files.length)}, async () => {
      while (!failed && cursor < manifest.files.length) {
        const item = manifest.files[cursor++];
        try { await verifyFile(item); } catch (error) { failed = true; throw error; }
      }
    }));
    if (checks.some(result => result.status === 'rejected')) throw Error();
    for (const required of ['python/python.exe','keywords.txt','scripts/voice-lab/run_duplex.py','scripts/voice-lab/runtime_probe.py','scripts/voice-lab/model.json','scripts/voice-lab/requirements.txt']) if (!names.has(required)) throw Error();
    // Refuse unlisted files: they could shadow an imported Python module.
    async function visit(directory) {
      for (const item of await fs.promises.readdir(directory, {withFileTypes:true})) {
        const file = path.join(directory,item.name);
        if (item.isSymbolicLink()) throw Error();
        if (item.isDirectory()) await visit(file);
        else if (!item.isFile() || (file !== manifestFile && !names.has(path.relative(resolved,file).split(path.sep).join('/').toLowerCase()))) throw Error();
      }
    }
    await visit(resolved);
    return {workerRoot:resolved,python:path.join(resolved,'python/python.exe'),model:path.join(resolved,'model'),keywords:path.join(resolved,'keywords.txt'),releaseApproved:manifest.releaseApproved === true,files:names.size};
  } catch { throw Error('VOICE_NATIVE_BUNDLE_INVALID'); }
}
module.exports = {verifyNativeVoiceBundle};
