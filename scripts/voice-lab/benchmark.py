"""Offline streaming KWS probe. No microphone, network, playback or user database."""
import argparse
import hashlib
import json
import platform
from pathlib import Path
import time
import wave

import numpy as np
import psutil
import sherpa_onnx


def read_pcm(path):
    with wave.open(str(path), 'rb') as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise ValueError('Fixture must be mono PCM16')
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768, wav.getframerate()


def run(model, chunk, keywords, files, repeats):
    process = psutil.Process()
    start = time.perf_counter()
    suffix = f'epoch-13-avg-2-chunk-{chunk}-left-64'
    paths = [model / f'encoder-{suffix}.int8.onnx', model / f'decoder-{suffix}.onnx', model / f'joiner-{suffix}.int8.onnx', model / 'tokens.txt', keywords]
    kws = sherpa_onnx.KeywordSpotter(tokens=str(paths[3]), encoder=str(paths[0]), decoder=str(paths[1]), joiner=str(paths[2]), keywords_file=str(keywords), num_threads=2, provider='cpu')
    load_ms = (time.perf_counter() - start) * 1000
    rows = []
    for path in files:
        samples, rate = read_pcm(path)
        for repeat in range(repeats):
            stream = kws.create_stream()
            detections = []
            block = max(1, int(rate * .02))
            # Tail flush is not original audio; report detections against supplied time.
            audio = np.concatenate([samples, np.zeros(int(rate * .8), dtype=np.float32)])
            started = time.perf_counter()
            cpu_start = process.cpu_times()
            for offset in range(0, len(audio), block):
                stream.accept_waveform(rate, audio[offset:offset + block])
                while kws.is_ready(stream):
                    kws.decode_stream(stream)
                    result = kws.get_result(stream)
                    if result:
                        detections.append({'keyword': result, 'inputTimeMs': round(min(offset + block, len(audio)) / rate * 1000)})
                        kws.reset_stream(stream)
            elapsed = time.perf_counter() - started
            cpu_end = process.cpu_times()
            rows.append({'fixture': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'repeat': repeat, 'audioSeconds': len(samples) / rate, 'wallMs': round(elapsed * 1000, 2), 'cpuMs': round((cpu_end.user + cpu_end.system - cpu_start.user - cpu_start.system) * 1000, 2), 'rtf': round(elapsed / (len(audio) / rate), 4), 'rssMiB': round(process.memory_info().rss / 1024**2, 2), 'detections': detections})
    return {'schema': 1, 'experiment': 'offline-kws', 'python': platform.python_version(), 'os': platform.platform(), 'sherpa': sherpa_onnx.__version__, 'chunk': chunk, 'threads': 2, 'quantization': 'encoder/joiner int8; decoder fp32', 'loadMs': round(load_ms, 2), 'assets': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}, 'limitations': ['Not real-time microphone playback', 'No labelled keyword end boundaries; inputTimeMs is not wake latency', 'Not an accuracy or AEC acceptance test', 'RSS includes the entire Python worker'], 'samples': rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--chunk', type=int, choices=[8, 16], default=8)
    parser.add_argument('--keywords', type=Path)
    parser.add_argument('--wav', type=Path, action='append')
    parser.add_argument('--repeats', type=int, choices=range(1, 101), default=3)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    files = args.wav or sorted((args.model / 'test_wavs').glob('*.wav'))
    if not files:
        parser.error('No WAV fixtures')
    result = run(args.model, args.chunk, args.keywords or args.model / 'test_wavs/keywords.txt', files, args.repeats)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), 'utf-8')
    print(json.dumps({'chunk': args.chunk, 'samples': len(result['samples']), 'loadMs': result['loadMs'], 'maxRtf': max(r['rtf'] for r in result['samples']), 'maxRssMiB': max(r['rssMiB'] for r in result['samples'])}))
