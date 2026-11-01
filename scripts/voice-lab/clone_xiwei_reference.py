"""Reproduce a selected local reference with the benchmark MOSS ONNX engine.

Creates an audition WAV and cached reference codes only, never changes the app.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import socket
import sys
import time


def no_network(*_args, **_kwargs):
    raise RuntimeError("Reference voice audition runs offline")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--moss-runtime", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int, choices=[1, 2, 4, 8], default=2)
    args = parser.parse_args()
    source = args.moss_runtime.read_bytes()
    if hashlib.sha256(source).hexdigest() != "99477efaff28c12c0c8e16a6b4aab4e880a70851693fa303d932415ba180cbd5":
        raise RuntimeError("MOSS runtime differs from reviewed snapshot")
    socket.create_connection = no_network
    socket.socket.connect = no_network
    socket.socket.connect_ex = no_network
    import numpy as np
    import onnxruntime as ort
    import sentencepiece as spm
    import soundfile as sf
    from scipy.signal import resample_poly
    ort.disable_telemetry_events()
    spec = importlib.util.spec_from_file_location("xiwei_reference_moss", args.moss_runtime)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    root = args.model_root.resolve()
    runtime = module.OrtCpuRuntime(root, thread_count=args.threads, max_new_frames=500, sample_mode="fixed")
    tokenizer = spm.SentencePieceProcessor(model_proto=(root / "MOSS-TTS-Nano-100M-ONNX/tokenizer.model").read_bytes())
    reference, rate = sf.read(str(args.reference), dtype="float32", always_2d=True)
    if not 1 <= len(reference)/rate <= 30 or not np.isfinite(reference).all():
        raise RuntimeError("Reference must contain 1–30 seconds of finite audio")
    reference = reference.mean(axis=1)
    target_rate = int(runtime.codec_meta["codec_config"]["sample_rate"])
    if rate != target_rate:
        factor = math.gcd(rate, target_rate)
        reference = resample_poly(reference, target_rate//factor, rate//factor).astype(np.float32)
    stereo = np.repeat(reference[None, None, :], 2, axis=1)
    began = time.perf_counter()
    encoder = runtime.sessions["codec_encode"]
    encoded = dict(zip([item.name for item in encoder.get_outputs()], encoder.run(None, {"waveform": stereo, "input_lengths": np.asarray([len(reference)], dtype=np.int32)}), strict=True))
    length = int(encoded["audio_code_lengths"].reshape(-1)[0])
    codes = encoded["audio_codes"][0, :length].astype(np.int32).tolist()
    encode_ms = (time.perf_counter()-began)*1000
    request = runtime.build_voice_clone_request_rows(codes, tokenizer.encode(args.text, out_type=int))
    chunks, pending, first_pcm = [], [], None
    began = time.perf_counter()
    runtime.codec_streaming_session.reset()

    def flush():
        nonlocal first_pcm
        if not pending:
            return
        decoded = runtime.codec_streaming_session.run_frames(pending.copy())
        pending.clear()
        if decoded is not None and decoded[1] > 0:
            audio, samples = decoded
            channels = np.asarray(audio).reshape(-1, np.asarray(audio).shape[-1])[:, :samples]
            chunks.append(channels.T.copy())
            if first_pcm is None:
                first_pcm = (time.perf_counter()-began)*1000

    def on_frame(_all, _step, frame):
        pending.append(frame)
        if len(pending) >= 4:
            flush()

    frames = runtime.generate_audio_frames(request, on_frame=on_frame)
    flush()
    if not chunks or len(frames) >= 500:
        raise RuntimeError("Reference audition was empty or reached generation limit")
    audio = np.concatenate(chunks, axis=0)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(args.output), audio, target_rate, subtype="PCM_16")
    metadata = {"reference": args.reference.name, "referenceSha256": hashlib.sha256(args.reference.read_bytes()).hexdigest(), "text": args.text, "codec": "MOSS-Audio-Tokenizer-Nano-ONNX", "referenceCodes": codes, "encodeReferenceMs": encode_ms, "firstPcmMs": first_pcm, "generationSeconds": time.perf_counter()-began, "audioSeconds": len(audio)/target_rate, "file": args.output.name, "selected": False, "appIntegrated": False}
    args.output.with_suffix(".json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in metadata.items() if key != "referenceCodes"}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
