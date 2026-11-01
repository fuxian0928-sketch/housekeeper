"""Build an isolated Windows voice runtime. Does not install, enable or open audio."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from runtime_notices import generate as generate_notices

ROOT = Path(__file__).resolve().parents[2]


def fetch(asset, cache):
    name = asset['file']
    if Path(name).name != name or '/' in name or '\\' in name:
        raise ValueError('Invalid asset filename')
    target = cache / name
    if not target.exists():
        partial = target.with_suffix(target.suffix + '.partial')
        with urllib.request.urlopen(asset['url'], timeout=30) as response, partial.open('wb') as stream:
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > asset['size']:
                    raise ValueError('Oversized asset')
                stream.write(chunk)
        verify(partial, asset)
        partial.replace(target)
    verify(target, asset)
    return target


def verify(file, asset):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    if file.stat().st_size != asset['size'] or digest.hexdigest() != asset['sha256']:
        raise ValueError('Asset integrity mismatch: ' + asset['file'])


def extract(archive, destination):
    with tarfile.open(archive) as source:
        members = source.getmembers()
        if sum(m.size for m in members) > 1024 * 1024 * 1024:
            raise ValueError('Expanded runtime too large')
        for member in members:
            target = (destination / member.name).resolve()
            if not target.is_relative_to(destination.resolve()) or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe runtime archive')
        source.extractall(destination, members=members, filter='data')


def verify_install(python, lock):
    code = "import sys,json,importlib.metadata;from pathlib import Path;root=Path(sys.executable).parent.resolve();names=json.loads(sys.argv[1]);assert Path(sys.prefix).resolve()==root;assert sys.version.split()[0]==sys.argv[2];assert all(Path(importlib.metadata.distribution(n).locate_file('')).resolve().is_relative_to(root) for n in names)"
    subprocess.run([str(python), '-I', '-c', code, json.dumps([a['name'] for a in lock['wheels']]), lock['python']['version']], check=True, timeout=30)


def build(destination, cache):
    if sys.platform != 'win32':
        raise RuntimeError('Windows build host required')
    if destination.exists():
        raise ValueError('Use a new output directory; existing output is never overwritten')
    lock = json.loads(Path(__file__).with_name('runtime-lock.json').read_text('utf-8'))
    requirements = [line for line in Path(__file__).with_name('requirements.txt').read_text().splitlines() if line and not line.startswith('#')]
    if set(requirements) != {a['name']+'=='+a['version'] for a in lock['wheels']}:
        raise ValueError('Dependency lock differs from runtime requirements')
    cache.mkdir(parents=True, exist_ok=True)
    archive = fetch(lock['python'], cache)
    wheels = [fetch(asset, cache) for asset in lock['wheels']]
    destination.mkdir(parents=True)
    extract(archive, destination)
    python = destination / 'python' / 'python.exe'
    if not python.is_file():
        raise ValueError('Runtime executable missing')
    # Installer runs only at build time. No index, resolver or user pip configuration.
    subprocess.run([str(python), '-I', '-m', 'pip', '--isolated', 'install', '--no-index', '--no-deps', '--no-compile', '--no-warn-script-location', '--disable-pip-version-check', *map(str, wheels)], check=True, timeout=180)
    subprocess.run([str(python), '-I', '-m', 'pip', '--isolated', 'check'], check=True, timeout=30)
    verify_install(python, lock)
    manifest = json.loads((ROOT/'package.json').read_text('utf-8'))
    resource = next(row for row in manifest['build']['extraResources'] if row['to']=='native-voice/scripts/voice-lab')
    scripts = destination/'scripts'/'voice-lab'
    scripts.mkdir(parents=True)
    for name in resource['filter']:
        shutil.copyfile(ROOT/resource['from']/name, scripts/name)
    result = subprocess.run([str(python), '-E', '-s', '-B', str(scripts/'runtime_probe.py')], cwd=destination, capture_output=True, timeout=30, check=True)
    if json.loads(result.stdout) != {'ready':True}:
        raise RuntimeError('Runtime import validation failed')
    notices = generate_notices(destination, lock)
    report = {'schema':1, 'python':lock['python']['version'], 'platform':lock['platform'], 'importsVerified':True, 'dependencyClosureVerified':True, 'audioDevicesOpened':False, 'releaseApproved':False, 'noticeComponentCount':len(notices['components']), 'lockSha256':hashlib.sha256(Path(__file__).with_name('runtime-lock.json').read_bytes()).hexdigest()}
    (destination/'runtime-build.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', type=Path)
    parser.add_argument('--cache', type=Path, default=ROOT/'outputs'/'voice-lab'/'runtime-downloads')
    args = parser.parse_args()
    build(args.destination.resolve(), args.cache.resolve())
