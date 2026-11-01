"""Bounded WASAPI lifecycle test. Output silence; input PCM never saved/uploaded."""
import argparse
import json
from pathlib import Path
import threading
import time

import numpy as np
import sounddevice as sd
from audio_pipeline import FreshFrameQueue

parser = argparse.ArgumentParser()
parser.add_argument('--input-name', required=True)
parser.add_argument('--output-name', required=True)
parser.add_argument('--seconds', type=int, choices=range(1, 31), default=5)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()

def find_device(name, direction):
    matches = [(i, d) for i, d in enumerate(sd.query_devices()) if d[f'max_{direction}_channels'] > 0 and name.lower() in d['name'].lower() and sd.query_hostapis(d['hostapi'])['name'] == 'Windows WASAPI']
    if len(matches) != 1:
        raise ValueError('Device selector must match exactly one WASAPI endpoint')
    return matches[0]

input_id, input_device = find_device(args.input_name, 'input')
output_id, output_device = find_device(args.output_name, 'output')
input_rate = int(input_device['default_samplerate'])
output_rate = int(output_device['default_samplerate'])
queue = FreshFrameQueue()
lock = threading.Lock()
stats = {'inputCallbacks': 0, 'outputCallbacks': 0, 'inputStatus': 0, 'outputStatus': 0, 'processedFrames': 0}
ages = []

def capture(data, frames, timestamps, status):
    with lock:
        stats['inputCallbacks'] += 1
        stats['inputStatus'] += bool(status)
        # PortAudio time and monotonic do not share an epoch; translate relative age.
        age = max(0, timestamps.currentTime - timestamps.inputBufferAdcTime)
        queue.push(data[:, 0], time.monotonic() - age)

def render(data, frames, timestamps, status):
    data.fill(0)
    stats['outputCallbacks'] += 1
    stats['outputStatus'] += bool(status)

settings = sd.WasapiSettings(exclusive=False)
started = time.monotonic()
with sd.InputStream(device=input_id, samplerate=input_rate, channels=1, dtype='float32', blocksize=input_rate//100, callback=capture, extra_settings=settings) as capture_stream:
    with sd.OutputStream(device=output_id, samplerate=output_rate, channels=2, dtype='float32', blocksize=output_rate//100, callback=render, extra_settings=settings) as render_stream:
        latency = {'input': capture_stream.latency, 'output': render_stream.latency}
        while time.monotonic() - started < args.seconds:
            with lock:
                frame = queue.pop()
            if frame is not None:
                ages.append((time.monotonic() - frame[0]) * 1000)
                stats['processedFrames'] += 1
            else:
                time.sleep(.002)
queue.clear()
result = {'experiment': 'wasapi-silent-duplex', 'durationSeconds': round(time.monotonic()-started,3), 'inputSampleRate': input_rate, 'outputSampleRate': output_rate, 'latencySeconds': latency, **stats, 'droppedFrames': queue.dropped, 'captureAgeP95Ms': round(float(np.percentile(ages,95)),2) if ages else None, 'streamsClosed': capture_stream.closed and render_stream.closed, 'retainedPcmBytes': 0, 'limitations': ['Silent output, no acoustic echo test', 'No user voice accuracy test', 'Not a long-run or hotplug acceptance test']}
args.report.write_text(json.dumps(result,indent=2),'utf-8')
print(json.dumps(result))
