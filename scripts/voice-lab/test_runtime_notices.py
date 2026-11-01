import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from runtime_notices import generate

class RuntimeNoticesTests(unittest.TestCase):
    def fixture(self, root):
        package=root/'python/Lib/site-packages/example-1.dist-info'
        package.mkdir(parents=True)
        (root/'python/LICENSE.txt').write_text('python license')
        (package/'METADATA').write_text('Name: example\nVersion: 1\n')
        source=root/'sources';source.mkdir()
        (source/'sources.json').write_text('{}')
        lock={'python':{'version':'3.11.16'},'wheels':[{'name':'example','version':'1','sha256':'a'*64}]}
        return package,source,lock

    def test_missing_materials_stay_visible_and_cannot_approve_release(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);package,source,lock=self.fixture(root)
            report=generate(root,lock,source)
            self.assertEqual(report['missingComponentMaterials'],['example'])
            self.assertFalse(report['releaseApproved'])
            self.assertNotIn(str(root),(root/'third-party-notices.json').read_text())

    def test_existing_notices_preserved_with_hash_and_supplement_checked(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);package,source,lock=self.fixture(root)
            (package/'NOTICE').write_text('original notice')
            license=source/'LICENSE.txt';license.write_text('upstream license')
            (source/'sources.json').write_text(json.dumps({'example':{'file':'LICENSE.txt','version':'1','sha256':hashlib.sha256(license.read_bytes()).hexdigest(),'source':'https://example.org/pinned/LICENSE','scope':'Project'}}))
            report=generate(root,lock,source)
            self.assertEqual(len(report['components'][0]['materials']),2)
            self.assertEqual((package/'NOTICE').read_text(),'original notice')
            license.write_text('tampered')
            with self.assertRaises(ValueError):generate(root,lock,source)

    def test_missing_package_and_version_mismatch_fail(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);package,source,lock=self.fixture(root)
            lock['wheels'][0]['version']='2'
            with self.assertRaises(ValueError):generate(root,lock,source)
            lock['wheels'][0]['name']='absent'
            with self.assertRaises(ValueError):generate(root,lock,source)

if __name__=='__main__':unittest.main()
