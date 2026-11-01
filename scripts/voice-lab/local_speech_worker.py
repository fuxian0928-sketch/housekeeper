"""Persistent offline ASR/TTS worker. JSON-lines only; no devices or network."""
from __future__ import annotations
import argparse
import base64
import json
import queue
import socket
import sys
import threading
import time
from pathlib import Path

def no_network(*_a, **_k):
    raise RuntimeError("LOCAL_SPEECH_NETWORK_DISABLED")

socket.create_connection = no_network
socket.socket.connect = no_network
socket.socket.connect_ex = no_network

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--threads", type=int, choices=[1, 2, 4], default=2)
    args = parser.parse_args()
    import numpy as np
    import onnxruntime as ort
    import sentencepiece as spm
    import sherpa_onnx
    from moss_ort_runtime import OrtCpuRuntime
    from speech_pcm import SpeechPcmEdges, split_oversized_text, sentence_pause_ms
    ort.disable_telemetry_events()
    output_lock = threading.Lock()
    def emit(**event):
        with output_lock:
            print(json.dumps(event, ensure_ascii=True, separators=(",", ":")), flush=True)

    root = args.models.resolve()
    asr_path = root / "asr"
    asr = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(asr_path / "tokens.txt"),
        encoder=str(asr_path / "encoder-epoch-99-avg-1.int8.onnx"),
        decoder=str(asr_path / "decoder-epoch-99-avg-1.onnx"),
        joiner=str(asr_path / "joiner-epoch-99-avg-1.int8.onnx"),
        num_threads=args.threads, provider="cpu", enable_endpoint_detection=False,
    )
    tts = OrtCpuRuntime(root, thread_count=args.threads, max_new_frames=1400, sample_mode="fixed")
    if int(tts.codec_meta["codec_config"]["sample_rate"]) != 48000:
        raise RuntimeError("LOCAL_SPEECH_FORMAT_MISMATCH")
    tokenizer = spm.SentencePieceProcessor(model_proto=(root / "MOSS-TTS-Nano-100M-ONNX/tokenizer.model").read_bytes())
    voice = json.loads((root / "xiwei-sweet-soft.json").read_text(encoding="utf-8"))
    if voice["referenceSha256"] != "d9a1bd9de87cceff2821e39cbdffcc866e633e78a41c7d54df9534e64370e771":
        raise RuntimeError("LOCAL_SPEECH_VOICE_MISMATCH")
    codes = voice["referenceCodes"]
    if not isinstance(codes, list) or not 1 <= len(codes) <= 400 or any(not isinstance(row, list) or len(row) != 16 or any(type(x) is not int or x < 0 or x > 8192 for x in row) for row in codes):
        raise RuntimeError("LOCAL_SPEECH_VOICE_INVALID")
    streams = {}
    jobs = {}
    jobs_lock = threading.Lock()
    pending_jobs = queue.Queue(maxsize=12)
    shutting_down = threading.Event()

    class Job:
        def __init__(self, ident):
            self.id = ident
            self.texts = queue.Queue(maxsize=3001)
            self.cancelled = threading.Event()
            self.condition = threading.Condition()
            self.credits = 8
            self.characters = 0
            self.synthesis_ms = 0
            self.credit_wait_ms = 0
            self.segments = 0
            self.trimmed_samples = 0
        def cancel(self):
            self.cancelled.set()
            with self.condition:
                self.condition.notify_all()
        def check(self):
            if self.cancelled.is_set() or shutting_down.is_set():
                raise InterruptedError()
        def audio(self, pcm):
            for offset in range(0, len(pcm), 6400):
                with self.condition:
                    wait_started = time.perf_counter()
                    while self.credits == 0:
                        self.check()
                        self.condition.wait(.1)
                    self.credit_wait_ms += (time.perf_counter() - wait_started) * 1000
                    self.check()
                    self.credits -= 1
                emit(type="pcm", id=self.id, pcm=base64.b64encode(pcm[offset:offset+6400]).decode("ascii"))

    def synthesize(job, text):
        began = time.perf_counter()
        # Keep generation bounded per sentence; context contains the fixed B reference.
        rows = tts.build_voice_clone_request_rows(codes, tokenizer.encode(text, out_type=int))
        tts.codec_streaming_session.reset()
        frames = []
        history = np.zeros(62, dtype=np.float32)
        n = np.arange(63, dtype=np.float32) - 31
        kernel = (2*.15*np.sinc(2*.15*n)*np.hamming(63)).astype(np.float32)
        kernel /= kernel.sum()
        phase = 0
        edges = SpeechPcmEdges(target_pause_ms=sentence_pause_ms(text))
        decode_queue = queue.Queue(maxsize=3)  # At most 960ms of encoded frames.
        decode_done = threading.Event()
        decode_stop = threading.Event()
        decode_errors = []
        def output_pcm(samples):
            if len(samples): job.audio((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
        def decode_frames(frame_rows):
            nonlocal history, phase
            job.check()
            decoded = tts.codec_streaming_session.run_frames(frame_rows)
            if decoded is None or decoded[1] <= 0:
                return
            audio, count = decoded
            channels = np.asarray(audio, dtype=np.float32).reshape(-1, np.asarray(audio).shape[-1])[:, :count]
            mono = channels.mean(axis=0)
            source = np.concatenate((history, mono))
            filtered = np.convolve(source, kernel, mode="valid")
            history = source[-62:].copy()
            output = filtered[(-phase) % 3::3]
            phase = (phase + len(mono)) % 3
            if not np.isfinite(output).all():
                raise RuntimeError("NONFINITE_PCM")
            output_pcm(edges.push(output))
        def decode_loop():
            try:
                while not decode_stop.is_set():
                    job.check()
                    try: batch = decode_queue.get(timeout=.05)
                    except queue.Empty: continue
                    if batch is None:
                        output_pcm(edges.finish())
                        break
                    decode_frames(batch)
            except Exception as error:
                decode_errors.append(error)
            finally:
                decode_done.set()
        decoder = threading.Thread(target=decode_loop, name="local-codec", daemon=True)
        decoder.start()
        def submit(batch):
            while True:
                job.check()
                if decode_errors: raise decode_errors[0]
                if decode_done.is_set(): raise RuntimeError("LOCAL_CODEC_STOPPED")
                try:
                    decode_queue.put(batch, timeout=.05)
                    return
                except queue.Full: continue
        def flush():
            if frames:
                submit(frames.copy())
                frames.clear()
        def on_frame(_all, _step, frame):
            job.check()
            frames.append(frame)
            if len(frames) >= 4:
                flush()
        succeeded = False
        try:
            # User-approved B-voice audition: stabilize the first 640ms, then
            # retain the fast sampled body without a context reset or respeeding.
            generated = tts.generate_audio_frames(rows, on_frame=on_frame,
                onset_frames=8)
            if len(generated) >= 1400 or not generated:
                raise RuntimeError("SYNTHESIS_LIMIT")
            flush()
            submit(None)
            while not decode_done.wait(.05): job.check()
            if decode_errors: raise decode_errors[0]
            succeeded = True
        finally:
            if not succeeded: job.cancel()
            decode_stop.set()
            # Retire the old codec before another sentence can reset its state.
            decoder.join()
        job.synthesis_ms += (time.perf_counter() - began) * 1000
        job.segments += 1
        job.trimmed_samples += edges.trimmed_samples

    def tts_loop():
        while not shutting_down.is_set():
            try:
                job = pending_jobs.get(timeout=.1)
            except queue.Empty:
                continue
            try:
                total_audio = False
                while True:
                    job.check()
                    try:
                        text = job.texts.get(timeout=.1)
                    except queue.Empty:
                        continue
                    if text is None:
                        if not total_audio:
                            raise RuntimeError("EMPTY_SYNTHESIS")
                        emit(type="done", id=job.id, synthesisMs=round(job.synthesis_ms), creditWaitMs=round(job.credit_wait_ms), segments=job.segments, trimmedMs=round(job.trimmed_samples/16))
                        break
                    for segment in split_oversized_text(text):
                        synthesize(job, segment)
                        total_audio = True
            except InterruptedError:
                pass
            except Exception:
                emit(type="error", id=job.id, code="LOCAL_SPEECH_SYNTHESIS_FAILED")
            finally:
                with jobs_lock:
                    jobs.pop(job.id, None)
    thread = threading.Thread(target=tts_loop, name="local-tts", daemon=True)
    thread.start()
    emit(type="ready", protocol=1, sampleRate=16000, channels=1, voice="xiwei-sweet-soft")
    try:
        while True:
            line = sys.stdin.buffer.readline(131073)
            if not line:
                break
            if len(line) > 131072:
                raise RuntimeError("INPUT_LIMIT")
            event = json.loads(line)
            ident = event.get("id")
            if not isinstance(ident, str) or not 1 <= len(ident) <= 80:
                continue
            operation = event.get("type")
            try:
                if operation == "asr-open":
                    if len(streams) >= 6 or ident in streams:
                        raise RuntimeError()
                    streams[ident] = {"stream": asr.create_stream(), "bytes": 0, "text": ""}
                    emit(type="opened", id=ident)
                elif operation == "asr-pcm":
                    item = streams[ident]
                    pcm = base64.b64decode(event["pcm"], validate=True)
                    if not 0 < len(pcm) <= 6400 or len(pcm) % 2 or item["bytes"] + len(pcm) > 1024000:
                        raise RuntimeError()
                    item["bytes"] += len(pcm)
                    stream = item["stream"]
                    stream.accept_waveform(16000, np.frombuffer(pcm, dtype="<i2").astype(np.float32)/32768)
                    while asr.is_ready(stream):
                        asr.decode_stream(stream)
                    text = asr.get_result(stream)
                    if text != item["text"]:
                        item["text"] = text
                        emit(type="partial", id=ident, text=text)
                elif operation == "asr-finish":
                    item = streams.pop(ident)
                    stream = item["stream"]
                    stream.accept_waveform(16000, np.zeros(9600, dtype=np.float32))
                    stream.input_finished()
                    while asr.is_ready(stream):
                        asr.decode_stream(stream)
                    emit(type="final", id=ident, text=asr.get_result(stream), audioBytes=item["bytes"])
                elif operation == "tts-open":
                    with jobs_lock:
                        if len(jobs) >= 12 or ident in jobs:
                            raise RuntimeError()
                        job = Job(ident)
                        jobs[ident] = job
                    pending_jobs.put_nowait(job)
                    emit(type="opened", id=ident)
                elif operation == "tts-text":
                    job = jobs[ident]
                    text = event["text"]
                    if not isinstance(text, str) or not text.strip() or job.characters + len(text) > 3000:
                        raise RuntimeError()
                    job.characters += len(text)
                    job.texts.put_nowait(text)
                elif operation == "tts-finish":
                    jobs[ident].texts.put_nowait(None)
                elif operation == "credit":
                    job = jobs.get(ident)
                    if job:
                        with job.condition:
                            job.credits = min(8, job.credits + 1)
                            job.condition.notify_all()
                elif operation == "cancel":
                    streams.pop(ident, None)
                    job = jobs.get(ident)
                    if job:
                        job.cancel()
            except Exception:
                streams.pop(ident, None)
                job = jobs.get(ident)
                if job:
                    job.cancel()
                emit(type="error", id=ident, code="LOCAL_SPEECH_INVALID_REQUEST")
    finally:
        shutting_down.set()
        for job in list(jobs.values()):
            job.cancel()
        thread.join(timeout=3)

if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"type":"fatal","code":"LOCAL_SPEECH_START_FAILED"}), flush=True)
        sys.exit(1)
