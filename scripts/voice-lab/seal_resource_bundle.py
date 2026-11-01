"""Assemble and verify generated voice resources, without enabling microphone capture."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from build_portable_runtime import ROOT, verify_install
from runtime_notices import generate


def digest(file):
    value=hashlib.sha256()
    with file.open('rb') as source:
        while chunk:=source.read(1024*1024):value.update(chunk)
    return value.hexdigest()


def seal(root, model):
    root=root.resolve();model=model.resolve()
    if (root/'bundle.json').exists() or (root/'model').exists():
        raise ValueError('Bundle already exists; never overwrite existing model or manifest')
    lock=json.loads((ROOT/'scripts/voice-lab/runtime-lock.json').read_text())
    report=json.loads((root/'runtime-build.json').read_text())
    if report.get('lockSha256')!=digest(ROOT/'scripts/voice-lab/runtime-lock.json'):
        raise ValueError('Runtime lock mismatch')
    python=root/'python/python.exe'
    verify_install(python,lock)
    definition=json.loads((ROOT/'scripts/voice-lab/model.json').read_text())
    for asset in definition['provenance']['runtimeAssets']:
        if Path(asset['file']).name!=asset['file'] or digest(model/asset['file'])!=asset['sha256']:
            raise ValueError('Model integrity mismatch')
    (root/'model').mkdir()
    for asset in definition['provenance']['runtimeAssets']:
        shutil.copyfile(model/asset['file'],root/'model'/asset['file'])
    resources=next(r for r in json.loads((ROOT/'package.json').read_text())['build']['extraResources'] if r['to']=='native-voice/scripts/voice-lab')
    scripts=root/'scripts/voice-lab';scripts.mkdir(parents=True,exist_ok=True)
    for name in resources['filter']:shutil.copyfile(ROOT/resources['from']/name,scripts/name)
    shutil.copyfile(ROOT/'scripts/voice-lab/xiao-e-keywords.txt',root/'keywords.txt')
    generate(root,lock)
    # Instantiate KWS/VAD/AEC with bundled files; never create an audio stream.
    check="import sys;from pathlib import Path;sys.path.insert(0,str(Path(sys.argv[1])/'scripts/voice-lab'));from duplex_runtime import DuplexEngine;engine=DuplexEngine(Path(sys.argv[1])/'model',Path(sys.argv[1])/'keywords.txt',lambda event:None);print('model-load-ok')"
    subprocess.run([str(python),'-I','-B','-c',check,str(root)],capture_output=True,timeout=30,check=True)
    files=[]
    for file in sorted(root.rglob('*')):
        if file.is_symlink() or not file.resolve().is_relative_to(root):raise ValueError('Linked resource')
        if file.is_file():files.append({'path':file.relative_to(root).as_posix(),'bytes':file.stat().st_size,'sha256':digest(file)})
    manifest={'schema':1,'platform':'win32-x64','python':'python/python.exe','model':'model','keywords':'keywords.txt','modelLoadVerified':True,'releaseApproved':False,'files':files}
    (root/'bundle.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'files':len(files),'bytes':sum(f['bytes'] for f in files),'modelLoadVerified':True,'audioDevicesOpened':False,'releaseApproved':False}))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('runtime',type=Path);parser.add_argument('model',type=Path);args=parser.parse_args();seal(args.runtime,args.model)
