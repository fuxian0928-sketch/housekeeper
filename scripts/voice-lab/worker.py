"""Experimental local KWS child. PCM over inherited stdio; no network/mic access.

Frames are fixed PCM16 mono 16kHz. The parent must do actual resampling.
Do not label raw WASAPI 48kHz frames as 16kHz. This is not the AEC adapter.
"""
import argparse
import base64
import json
from pathlib import Path
import sys
import time

import numpy as np
import sherpa_onnx


class WakeSession:
    def __init__(self):
        self.generation = 0
        self.sequence = 0
        self.active = False
        self.ring = bytearray()

    def reset(self, generation):
        if type(generation) is not int or generation <= self.generation:
            return False
        self.generation = generation
        self.sequence = 0
        self.active = False
        self.ring.clear()
        return True

    def accept(self, generation, sequence, pcm):
        if generation != self.generation or type(sequence) is not int or sequence <= self.sequence:
            return False
        if not pcm or len(pcm) > 3200 or len(pcm) % 2:
            raise ValueError('PCM must contain 1-100ms of mono 16kHz PCM16')
        self.sequence = sequence
        self.ring.extend(pcm)
        del self.ring[:-48000]  # exactly 1.5s; never persisted
        return True

    def trigger(self):
        if self.active:
            return False
        self.active = True
        return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--keywords', required=True)
    args = parser.parse_args()
    suffix = 'epoch-13-avg-2-chunk-8-left-64'
    kws = sherpa_onnx.KeywordSpotter(tokens=str(args.model / 'tokens.txt'), encoder=str(args.model / f'encoder-{suffix}.int8.onnx'), decoder=str(args.model / f'decoder-{suffix}.onnx'), joiner=str(args.model / f'joiner-{suffix}.int8.onnx'), keywords_file=args.keywords, num_threads=2, provider='cpu')
    state = WakeSession()
    stream = kws.create_stream()

    def emit(kind, **fields):
        print(json.dumps({'type': kind, 'generation': state.generation, **fields}), flush=True)

    emit('ready', protocol=1, sampleRate=16000, channels=1, format='pcm16le', aec=False)
    while True:
        line = sys.stdin.buffer.readline(16385)
        if not line:
            return
        if len(line) > 16384 or not line.endswith(b'\n'):
            emit('error', code='FRAME_TOO_LARGE')
            return
        try:
            message = json.loads(line)
            if message['type'] == 'stop':
                state.ring.clear()
                emit('stopped')
                return
            if message['type'] == 'reset':
                if state.reset(message['generation']):
                    stream = kws.create_stream()
                    emit('standby')
                continue
            if message['type'] == 'ping':
                emit('alive', active=state.active)
                continue
            if message['type'] != 'pcm' or state.generation == 0:
                raise ValueError('Invalid command')
            pcm = base64.b64decode(message['data'], validate=True)
            if not state.accept(message['generation'], message['sequence'], pcm):
                continue
            if state.active:
                continue
            began = time.perf_counter()
            stream.accept_waveform(16000, np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768)
            while kws.is_ready(stream):
                kws.decode_stream(stream)
                if kws.get_result(stream) and state.trigger():
                    emit('wake', sequence=state.sequence, bufferedBytes=len(state.ring), processingMs=round((time.perf_counter() - began) * 1000, 2))
                    kws.reset_stream(stream)
                    break
        except (ValueError, KeyError, TypeError):
            emit('error', code='INVALID_COMMAND')


if __name__ == '__main__':
    main()
