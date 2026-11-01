"""Design virtual voices locally with an explicitly prepared Qwen VoiceDesign model.

This offline authoring tool does not open audio devices, change the application,
or upload speech. Full float32 CPU inference preserves the design model's
precision. The output is a candidate reference voice, not a live provider.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import threading
import time


def report(stage, **values):
    print(json.dumps({"stage": stage, **values}, ensure_ascii=False), flush=True)


def no_network(*_args, **_kwargs):
    raise RuntimeError("Voice design inference is offline; network connections are disabled")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--recipe", type=Path, default=Path(__file__).with_name("xiwei-sweet-voices.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--candidate", action="append")
    parser.add_argument("--threads", type=int, choices=[2, 4, 8], default=4)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    model_dir = args.model_dir.expanduser().resolve()
    recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
    if not isinstance(recipe.get("text"), str) or not 1 <= len(recipe["text"]) <= 500:
        parser.error("Audition text must contain 1–500 characters")
    for item in recipe.get("candidates", []):
        if not isinstance(item.get("id"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", item["id"]):
            parser.error("Candidate IDs must be short, safe filenames")
        if not isinstance(item.get("instruction"), str) or not 1 <= len(item["instruction"]) <= 2000 or type(item.get("seed")) is not int:
            parser.error("Each candidate requires a bounded instruction and integer seed")
    candidates = [item for item in recipe["candidates"] if not args.candidate or item["id"] in args.candidate]
    if not candidates:
        parser.error("No matching candidate")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", TOKENIZERS_PARALLELISM="false", HF_HUB_DISABLE_TELEMETRY="1", OMP_NUM_THREADS=str(args.threads))
    socket.create_connection = no_network
    socket.socket.connect = no_network
    socket.socket.connect_ex = no_network
    import numpy as np
    import psutil
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.set_flush_denormal(True)
    process = psutil.Process()
    stopped = threading.Event()
    phase = {"name": "load_model", "began": time.perf_counter()}

    def monitor():
        low_memory = 0
        while not stopped.wait(20):
            free_mb = psutil.virtual_memory().available / 1024**2
            report(phase["name"], elapsedSeconds=round(time.perf_counter()-phase["began"], 1), rssMB=round(process.memory_info().rss/1024**2), freeMB=round(free_mb))
            low_memory = low_memory+1 if free_mb < 700 else 0
            if low_memory >= 2:
                report("aborted_low_memory")
                os._exit(31)

    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    model = None
    try:
        report("load_model", path=str(model_dir), threads=args.threads)
        model = Qwen3TTSModel.from_pretrained(str(model_dir), device_map="cpu", dtype=torch.float32, attn_implementation="eager", local_files_only=True)
        codec = model.model.speech_tokenizer.model
        model.model.eval()
        codec.eval()
        report("model_ready", rssMB=round(process.memory_info().rss/1024**2), dtype="float32")
        for candidate in candidates:
            target = args.output / (candidate["id"]+".wav")
            phase.update(name="generate_"+candidate["id"], began=time.perf_counter())
            report("candidate_start", id=candidate["id"], label=candidate["label"])
            torch.manual_seed(candidate["seed"])
            np.random.seed(candidate["seed"])
            started = time.perf_counter()
            with torch.inference_mode():
                wavs, sample_rate = model.generate_voice_design(text=recipe["text"], language="Chinese", instruct=candidate["instruction"], non_streaming_mode=True, do_sample=True, temperature=.8, top_k=50, top_p=.95, repetition_penalty=1.05, max_new_tokens=384)
            audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
            if not np.isfinite(audio).all() or len(audio) < sample_rate or float(np.max(np.abs(audio))) < .01:
                raise RuntimeError("Voice candidate has invalid or empty audio")
            if len(audio)/sample_rate > min(25, max(12, len(recipe["text"])*.65)):
                raise RuntimeError("Short audition exceeded its expected duration; inspect generation before delivery")
            sf.write(str(target), audio, sample_rate, subtype="PCM_16")
            metadata = {**candidate, "text": recipe["text"], "modelRepository": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "modelRevision": "5ecdb67327fd37bb2e042aab12ff7391903235d3", "mode": "offline CPU float32", "durationSeconds": len(audio)/sample_rate, "generationSeconds": time.perf_counter()-started, "sampleRate": sample_rate, "peak": float(np.max(np.abs(audio))), "rms": float(np.sqrt(np.mean(audio**2))), "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "file": target.name, "selected": False, "appIntegrated": False}
            target.with_suffix(".json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
            report("candidate_ready", **metadata)
            gc.collect()
    finally:
        stopped.set()
        del model
        gc.collect()


if __name__ == "__main__":
    main()
