"""Offline CPU feasibility probe, independent of the app and live audio devices.

Uses explicit local model/runtime paths; never downloads, opens a microphone,
plays audio or changes application settings. Built-in TTS voice is a benchmark,
not the user's designed voice. Model/runtime provenance belongs in the report.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import platform
from pathlib import Path
import socket
import sys
import time
import wave


def block_connections(*_args, **_kwargs):
    raise RuntimeError("Network is disabled during the local voice probe")


def write_wav(path, samples, sample_rate):
    import numpy as np
    values = np.asarray(samples, dtype=np.float32)
    if values.ndim == 1:
        values = values.reshape(-1, 1)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(values.shape[1])
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((np.clip(values, -1, 1) * 32767).astype("<i2").tobytes())


def asr_probe(root, threads, files=None, repetitions=3):
    import numpy as np
    import sherpa_onnx
    import soundfile as sf
    directory = root / "asr"
    start = time.perf_counter()
    recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(directory / "tokens.txt"),
        encoder=str(directory / "encoder-epoch-99-avg-1.int8.onnx"),
        decoder=str(directory / "decoder-epoch-99-avg-1.onnx"),
        joiner=str(directory / "joiner-epoch-99-avg-1.int8.onnx"),
        num_threads=threads, provider="cpu", enable_endpoint_detection=False,
    )
    load_ms = (time.perf_counter() - start) * 1000
    results = []
    for path in files or sorted((directory / "test_wavs").glob("*.wav")):
        samples, rate = sf.read(path, dtype="float32", always_2d=True)
        samples = samples.mean(axis=1)
        for repetition in range(repetitions):
            stream = recognizer.create_stream()
            start = time.perf_counter()
            partials = []
            step = max(1, int(rate * .02))
            for offset in range(0, len(samples), step):
                stream.accept_waveform(rate, samples[offset:offset+step])
                while recognizer.is_ready(stream):
                    recognizer.decode_stream(stream)
                text = recognizer.get_result(stream)
                if text and (not partials or partials[-1]["text"] != text):
                    partials.append({"audioAtMs": round((offset+step)/rate*1000, 1), "text": text})
            tail = time.perf_counter()
            stream.accept_waveform(rate, np.zeros(int(rate*.6), dtype="float32"))
            stream.input_finished()
            while recognizer.is_ready(stream):
                recognizer.decode_stream(stream)
            end = time.perf_counter()
            results.append({"file": path.name, "run": repetition, "text": recognizer.get_result(stream),
                "audioSeconds": len(samples)/rate, "computeMs": (end-start)*1000,
                "finalFlushMs": (end-tail)*1000, "rtf": (end-start)/(len(samples)/rate),
                "firstPartialAudioAtMs": partials[0]["audioAtMs"] if partials else None,
                "partialChanges": len(partials)})
            print("ASR", json.dumps(results[-1], ensure_ascii=False), flush=True)
    if not results:
        raise RuntimeError("No local ASR test wave files")
    return {"model": directory.name, "threads": threads, "loadMs": load_ms,
        "feedMode": "20ms chunks fed faster than realtime; excludes microphone/VAD endpoint waiting", "runs": results}


def tts_probe(root, runtime_path, output, threads):
    import numpy as np
    import sentencepiece as spm
    source = runtime_path.read_bytes()
    if hashlib.sha256(source).hexdigest() != "99477efaff28c12c0c8e16a6b4aab4e880a70851693fa303d932415ba180cbd5":
        raise RuntimeError("Upstream runtime differs from the reviewed experiment snapshot")
    spec = importlib.util.spec_from_file_location("xiwei_moss_probe_runtime", runtime_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    start = time.perf_counter()
    runtime = module.OrtCpuRuntime(root, thread_count=threads, max_new_frames=500, sample_mode="fixed")
    load_ms = (time.perf_counter()-start)*1000
    # SentencePiece's Windows filename API can lose non-ASCII user-directory names.
    tokenizer = spm.SentencePieceProcessor(model_proto=(root / "MOSS-TTS-Nano-100M-ONNX/tokenizer.model").read_bytes())
    voices = runtime.list_builtin_voices()
    voice = next(item for item in voices if item["voice"] == "Lingyu")
    texts = ["主人，我在。", "主人，我在。", "主人，我在。", "我会先查看项目记录，再告诉你已经完成的事项，以及接下来需要确认的地方。"]
    results = []
    for index, text in enumerate(texts):
        request = runtime.build_voice_clone_request_rows(voice["prompt_audio_codes"], tokenizer.encode(text, out_type=int))
        runtime.codec_streaming_session.reset()
        chunks, arrivals, pending = [], [], []
        start = time.perf_counter()

        def decode_pending():
            if not pending:
                return
            decoded = runtime.codec_streaming_session.run_frames(pending.copy())
            pending.clear()
            if decoded is None:
                return
            audio, length = decoded
            if length:
                # The codec emits channel-major [1, channels, samples].
                channels = np.asarray(audio).reshape(-1, np.asarray(audio).shape[-1])[:, :length]
                chunks.append(channels.T.copy())
                arrivals.append({"atSeconds": time.perf_counter()-start, "audioSamples": length})

        def on_frame(_all, _index, frame):
            pending.append(frame)
            if len(pending) >= 4:
                decode_pending()

        frames = runtime.generate_audio_frames(request, on_frame=on_frame)
        decode_pending()
        elapsed = time.perf_counter()-start
        if not chunks:
            raise RuntimeError("TTS produced no playable audio")
        audio = np.concatenate(chunks, axis=0)
        rate = int(runtime.codec_meta["codec_config"]["sample_rate"])
        duration = len(audio)/rate
        target = output / f"tts-cpu-{index}.wav"
        write_wav(target, audio, rate)
        # Earliest uninterrupted playback start under measured chunk arrivals.
        previous_audio = 0
        uninterrupted_start = 0
        for chunk in arrivals:
            uninterrupted_start = max(uninterrupted_start, chunk["atSeconds"]-previous_audio/rate)
            previous_audio += chunk["audioSamples"]
        result = {"text": text, "run": index, "voice": voice["voice"], "voiceKind": "upstream benchmark voice, not Xiwei's designed voice",
            "firstPcmMs": arrivals[0]["atSeconds"]*1000, "generationMs": elapsed*1000,
            "audioSeconds": duration, "rtf": elapsed/duration, "chunks": len(chunks),
            "uninterruptedStartMs": uninterrupted_start*1000, "frameLimitReached": len(frames) >= 500,
            "file": str(target)}
        results.append(result)
        print("TTS", json.dumps(result, ensure_ascii=False), flush=True)
    return {"runtimeSha256": hashlib.sha256(source).hexdigest(), "threads": threads,
        "loadMs": load_ms, "chunkFrames": 4, "runs": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--moss-runtime", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int, choices=[1, 2, 4, 8], default=2)
    parser.add_argument("--asr-only", action="store_true")
    parser.add_argument("--tts-only", action="store_true")
    parser.add_argument("--asr-input", type=Path, action="append", help="Explicit local WAV to check instead of the public fixture files")
    parser.add_argument("--repetitions", type=int, choices=[1, 3], default=3)
    args = parser.parse_args()
    if args.asr_only and args.tts_only:
        parser.error("Choose at most one isolated stage")
    args.output.mkdir(parents=True, exist_ok=True)
    socket.create_connection = block_connections
    socket.socket.connect = block_connections
    socket.socket.connect_ex = block_connections
    import onnxruntime
    onnxruntime.disable_telemetry_events()
    report = {"python": sys.version, "platform": platform.platform(), "onnxruntime": onnxruntime.__version__,
        "pythonNetworkBlocked": True, "opensAudioDevices": False, "appIntegrated": False,
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    report_path = args.output / "report.json"
    try:
        if not args.tts_only:
            report["asr"] = asr_probe(args.model_root.resolve(), args.threads, args.asr_input, args.repetitions)
        if not args.asr_only:
            report["tts"] = tts_probe(args.model_root.resolve(), args.moss_runtime.resolve(), args.output.resolve(), args.threads)
    finally:
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("REPORT", str(report_path.resolve()), flush=True)


if __name__ == "__main__":
    main()
