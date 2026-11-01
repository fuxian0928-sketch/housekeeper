const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// App-owned manifest only. No renderer-selected executable or manifest is accepted.
async function verifyNativeVoiceAssets({ appRoot, model }) {
  let assets;
  try {
    const manifestPath = path.join(appRoot, 'scripts/voice-lab/model.json');
    if (fs.statSync(manifestPath).size > 65536) throw Error();
    assets = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')).provenance.runtimeAssets;
    if (!Array.isArray(assets) || assets.length !== 4 || new Set(assets.map(a => a.file)).size !== 4) throw Error();
    for (const asset of assets) {
      if (typeof asset.file !== 'string' || !asset.file || asset.file.includes('/') || asset.file.includes('\\') || asset.file === '.' || asset.file === '..' || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw Error();
    }
  } catch { throw Error('VOICE_NATIVE_MANIFEST_INVALID'); }
  if (typeof model !== 'string' || !path.isAbsolute(model)) throw Error('VOICE_NATIVE_ASSET_MISSING');
  for (const asset of assets) {
    let handle;
    try {
      handle = await fs.promises.open(path.join(model, asset.file), 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 256 * 1024 * 1024) throw Error();
    } catch { await handle?.close().catch(() => {}); throw Error('VOICE_NATIVE_ASSET_MISSING'); }
    try {
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > 256 * 1024 * 1024) throw Error();
        hash.update(chunk);
      }
      if (hash.digest('hex') !== asset.sha256) throw Error();
    } catch { throw Error('VOICE_NATIVE_ASSET_INVALID'); }
    finally { await handle.close(); }
  }
  return { verified: true, files: assets.length };
}
module.exports = { verifyNativeVoiceAssets };
