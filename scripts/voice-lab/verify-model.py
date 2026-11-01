"""Check runtime assets against pinned upstream provenance; never start audio."""
import hashlib
import json
from pathlib import Path
import sys


def verify(directory):
    manifest = json.loads(Path(__file__).with_name('model.json').read_text('utf-8'))
    results = []
    for asset in manifest['provenance']['runtimeAssets']:
        file = directory / asset['file']
        digest = hashlib.sha256(file.read_bytes()).hexdigest() if file.is_file() else None
        results.append({'file': asset['file'], 'matches': digest == asset['sha256']})
    return {'model': manifest['id'], 'assets': results,
            'verified': all(row['matches'] for row in results),
            'releaseApproved': False}


if __name__ == '__main__':
    result = verify(Path(sys.argv[1]))
    print(json.dumps(result))
    sys.exit(0 if result['verified'] else 1)
