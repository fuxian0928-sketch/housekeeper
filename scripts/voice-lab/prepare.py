"""Download a pinned experimental model; never install or enable listening."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile
import urllib.request

manifest = json.loads(Path(__file__).with_name('model.json').read_text('utf-8'))
target = Path(sys.argv[1] if len(sys.argv) > 1 else 'outputs/voice-lab').resolve()
target.mkdir(parents=True, exist_ok=True)
archive = target / 'model.tar.bz2'
if not archive.exists():
    with urllib.request.urlopen(manifest['url'], timeout=60) as response, archive.open('wb') as out:
        while data := response.read(1024 * 1024):
            out.write(data)
if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest['sha256']:
    raise RuntimeError('Model digest mismatch; refusing extraction')
with tarfile.open(archive) as tar:
    for member in tar.getmembers():
        path = (target / member.name).resolve()
        if not path.is_relative_to(target) or not (member.isfile() or member.isdir()):
            raise RuntimeError('Unsafe archive member')
    tar.extractall(target, filter='data')
print(json.dumps({'model': manifest['id'], 'sha256': manifest['sha256'], 'ready': True}))
