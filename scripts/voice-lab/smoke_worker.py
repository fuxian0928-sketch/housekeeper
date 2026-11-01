"""Runs the actual native inference child on a labelled synthetic fixture."""
import audioop
import base64
import json
from pathlib import Path
import subprocess
import sys
import wave

model, wav_path, output = map(Path, sys.argv[1:4])
with wave.open(str(wav_path)) as wav:
    if wav.getsampwidth() != 2 or wav.getnchannels() != 1:
        raise ValueError('Expected mono PCM16 fixture')
    pcm, _ = audioop.ratecv(wav.readframes(wav.getnframes()), 2, 1, wav.getframerate(), 16000, None)
pcm += bytes(16000 * 2)
commands = [{'type': 'reset', 'generation': 1}]
for sequence, offset in enumerate(range(0, len(pcm), 640), 1):
    commands.append({'type': 'pcm', 'generation': 1, 'sequence': sequence, 'data': base64.b64encode(pcm[offset:offset + 640]).decode('ascii')})
commands += [{'type': 'reset', 'generation': 2}]
# An old completed phrase must not wake the new session.
commands += [{**command, 'generation': 1} for command in commands[1:-1]]
commands += [{'type': 'ping'}, {'type': 'stop'}]
result = subprocess.run([sys.executable, str(Path(__file__).with_name('worker.py')), '--model', str(model), '--keywords', str(Path(__file__).with_name('xiao-e-keywords.txt'))], input=''.join(json.dumps(c) + '\n' for c in commands), text=True, capture_output=True, timeout=30, check=True)
events = [json.loads(line) for line in result.stdout.splitlines()]
assert len([e for e in events if e['type'] == 'wake']) == 1, events
assert all(e['generation'] == 1 for e in events if e['type'] == 'wake'), events
assert not any(e['type'] == 'error' for e in events), events
assert events[-1]['type'] == 'stopped', events
output.write_text(json.dumps({'fixture': wav_path.name, 'synthetic': True, 'events': events, 'checks': ['one wake for repeated keyword', 'old PCM ignored after reset', 'clean child shutdown']}, indent=2), 'utf-8')
print(json.dumps({'passed': True, 'events': len(events)}))
