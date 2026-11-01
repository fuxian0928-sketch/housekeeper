"""Deterministic digital echo path, never a real-speaker AEC acceptance claim."""
import argparse
import audioop
import hashlib
import json
from pathlib import Path
import time
import wave
import numpy as np
from audio_pipeline import EchoPipeline

parser = argparse.ArgumentParser()
parser.add_argument('output', type=Path)
parser.add_argument('--far', type=Path)
parser.add_argument('--near', type=Path)
parser.add_argument('--write-synthetic-wavs', type=Path)
args = parser.parse_args()
if bool(args.far) != bool(args.near):
    parser.error('Provide both near and far WAV fixtures')
rate = 16000
rng = np.random.default_rng(20260919)
count = rate * 30
# Deterministic speech-band noise, independent near/far tracks.
def signal():
    spectrum = np.fft.rfft(rng.normal(size=count))
    frequencies = np.fft.rfftfreq(count, 1 / rate)
    spectrum[(frequencies < 200) | (frequencies > 3500)] = 0
    track = np.fft.irfft(spectrum, n=count)
    return (track / np.max(np.abs(track)) * .35).astype(np.float32)

def speech(path):
    with wave.open(str(path)) as wav:
        if wav.getsampwidth() != 2 or wav.getnchannels() != 1:
            raise ValueError('Expected mono PCM16')
        data, _ = audioop.ratecv(wav.readframes(wav.getnframes()), 2, 1, wav.getframerate(), rate, None)
    samples = np.frombuffer(data, '<i2').astype(np.float32) / 32768
    samples = np.concatenate([samples, np.zeros(rate//3,np.float32)])
    return np.tile(samples, int(np.ceil(count/len(samples))))[:count]

far = speech(args.far) if args.far else signal()
near = speech(args.near) if args.near else signal()
near[:20 * rate] = 0
echo = np.zeros(count, np.float32)
for delay, gain in [(40, .45), (65, .18), (90, .08)]:
    shift = rate * delay // 1000
    echo[shift:] += gain * far[:-shift]
microphone = near + echo
pipeline = EchoPipeline(rate=rate, delay_ms=40)
clean = np.zeros(count, np.float32)
started = time.perf_counter()
for offset in range(0, count, 160):
    clean[offset:offset + 160] = pipeline.process(microphone[offset:offset + 160], far[offset:offset + 160])
elapsed = time.perf_counter() - started
window = slice(10 * rate, 20 * rate)
erle = 10 * np.log10(np.mean(echo[window] ** 2) / max(np.mean(clean[window] ** 2), 1e-12))
# Report best short alignment because APM adds buffering. Do not confuse suppression with preserved speech.
reference = near[25 * rate:29 * rate]
correlations = [float(np.corrcoef(reference, clean[25 * rate + lag:29 * rate + lag])[0, 1]) for lag in range(321)]
lag = int(np.argmax(correlations))
output = clean[25 * rate + lag:29 * rate + lag]
result = {'experiment': 'digital-aec-only', 'seed': 20260919, 'seconds': 30, 'sampleRate': rate, 'pywebrtcAudio': '0.2.0', 'echoPathMs': [40,65,90], 'rtf': round(elapsed / 30, 5), 'farOnlyErleDb': round(float(erle), 2), 'doubleTalkCorrelation': round(correlations[lag], 4), 'alignmentSamples': lag, 'nearOutputRmsRatio': round(float(np.sqrt(np.mean(output**2) / np.mean(reference**2))), 4), 'limitations': ['Synthetic stationary digital echo; not hardware', 'No nonlinear speaker, clock drift or actual device latency', 'No human intelligibility assessment']}
result['stimulus'] = 'speech' if args.far else 'speech-band-noise'
if args.far:
    result['fixtures'] = {key: {'name': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for key,path in [('far',args.far),('near',args.near)]}
args.output.write_text(json.dumps(result, indent=2), 'utf-8')
if args.write_synthetic_wavs:
    args.write_synthetic_wavs.mkdir(parents=True, exist_ok=True)
    for name, samples in [('far-only-raw',microphone[10*rate:20*rate]), ('far-only-clean',clean[10*rate:20*rate]), ('double-talk-clean',clean[20*rate:]), ('near-reference',near[20*rate:])]:
        with wave.open(str(args.write_synthetic_wavs / (name + '.wav')), 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes((np.clip(samples,-1,1)*32767).astype('<i2').tobytes())
print(json.dumps(result))
