"""Inventory preserved license materials; does not grant release approval."""
import hashlib
import json
from email.parser import Parser
from pathlib import Path
import shutil


def material(file, root):
    resolved = file.resolve()
    if not resolved.is_relative_to(root.resolve()) or not resolved.is_file():
        raise ValueError('Notice outside runtime')
    return {'path':file.relative_to(root).as_posix(), 'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}


def is_notice(file):
    return file.name.lower().startswith(('license', 'copying', 'notice', 'authors'))


def generate(root, lock, supplements=None):
    root = Path(root).resolve()
    supplements = Path(supplements or Path(__file__).with_name('notices'))
    material(root/'python/LICENSE.txt', root)
    source = json.loads((supplements/'sources.json').read_text('utf-8'))
    records = []
    expected = {a['name']:a for a in lock['wheels']}
    seen = set()
    for directory in sorted((root/'python/Lib/site-packages').glob('*.dist-info')):
        meta = Parser().parsestr((directory/'METADATA').read_text('utf-8'))
        name, version = meta['Name'], meta['Version']
        if not name or not version or name in seen:
            raise ValueError('Invalid or duplicate distribution metadata')
        seen.add(name)
        if name in expected and version != expected[name]['version']:
            raise ValueError('Notice version mismatch')
        files = [material(p, root) for p in sorted(directory.rglob('*')) if p.is_file() and is_notice(p)]
        extra = source.get(name)
        if extra:
            if extra['version'] != version or Path(extra['file']).name != extra['file']:
                raise ValueError('Supplement version/path mismatch')
            license_file = supplements/extra['file']
            if hashlib.sha256(license_file.read_bytes()).hexdigest() != extra['sha256']:
                raise ValueError('Supplement integrity mismatch')
            target = root/'third-party-notices'/extra['file']
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(license_file,target)
            files.append({**material(target,root),'source':extra['source'],'scope':extra['scope']})
        records.append({'name':name,'version':version,'artifactSha256':expected.get(name,{}).get('sha256'), 'materials':files})
    missing_packages = sorted(set(expected)-seen)
    # Include notices outside wheel metadata (CPython and vendored dependencies).
    inventory = [material(p,root) for p in sorted((root/'python').rglob('*')) if p.is_file() and is_notice(p)]
    report = {'schema':1,'python':lock['python']['version'],'components':records,'preservedMaterials':inventory,
              'missingPackages':missing_packages,'missingComponentMaterials':[r['name'] for r in records if not r['materials']],
              'releaseApproved':False,'remainingReview':['Native libraries bundled inside wheels and interpreter','Wake model attribution','Installer distribution and clean-machine acceptance']}
    if missing_packages:
        raise ValueError('Runtime packages missing from notice inventory')
    (root/'third-party-notices.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    text = ['# Voice runtime third-party materials', '', 'Original license and attribution files remain at the paths below. This index is not a release approval.', '', '## Python '+lock['python']['version'], '', '- python/LICENSE.txt', '', '## Python packages', '']
    for row in records:
        text += ['### '+row['name']+' '+row['version'], '']
        text += ['- '+item['path'] for item in row['materials']] or ['- Materials missing: review required.']
        text += ['']
    (root/'THIRD-PARTY-NOTICES.md').write_text('\n'.join(text),encoding='utf-8')
    return report
