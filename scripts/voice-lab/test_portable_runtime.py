import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from build_portable_runtime import extract, verify, fetch

class PortableRuntimeTests(unittest.TestCase):
    def test_corrupt_cached_asset_is_rejected_before_use(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);file=root/'asset.zip';file.write_bytes(b'bad')
            asset={'file':'asset.zip','size':3,'sha256':hashlib.sha256(b'yes').hexdigest()}
            with self.assertRaises(ValueError): fetch(asset,root)
            file.write_bytes(b'yes');self.assertEqual(fetch(asset,root),file)

    def test_extraction_rejects_escape_and_links_before_writing(self):
        for name,kind in [('../escaped',tarfile.REGTYPE),('python/link',tarfile.SYMTYPE)]:
            with tempfile.TemporaryDirectory() as temp:
                root=Path(temp);archive=root/'runtime.tar.gz';dest=root/'output';dest.mkdir()
                with tarfile.open(archive,'w:gz') as tar:
                    member=tarfile.TarInfo(name);member.type=kind;member.linkname='../outside'
                    tar.addfile(member,io.BytesIO(b''))
                with self.assertRaises(ValueError):extract(archive,dest)
                self.assertEqual(list(dest.iterdir()),[])

    def test_regular_runtime_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);archive=root/'runtime.tar.gz';dest=root/'output';dest.mkdir()
            with tarfile.open(archive,'w:gz') as tar:
                member=tarfile.TarInfo('python/LICENSE.txt');member.size=3
                tar.addfile(member,io.BytesIO(b'abc'))
            extract(archive,dest)
            self.assertEqual((dest/'python/LICENSE.txt').read_bytes(),b'abc')

if __name__=='__main__':unittest.main()
