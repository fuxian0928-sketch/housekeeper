"""Fetch public, pinned model assets for an isolated CPU benchmark; no user audio."""
import concurrent.futures
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
ROOT = parser.parse_args().output.expanduser().resolve()
ROOT.mkdir(parents=True, exist_ok=True)
MODELS = ROOT / "models"
PLAN = [
    ("OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX", "f52645cb467506d8e18e746ddd59482685b74e58", "MOSS-TTS-Nano-100M-ONNX", None),
    ("OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX", "ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae", "MOSS-Audio-Tokenizer-Nano-ONNX", None),
    ("csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20", "98590b7ed6443e77b714204da2757d75e1a642f4", "asr", {"encoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.onnx", "joiner-epoch-99-avg-1.int8.onnx", "tokens.txt", "test_wavs/1.wav", "test_wavs/0.wav"}),
]

def read_json(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)

jobs = []
record = []
for repo, revision, directory, selected in PLAN:
    data = read_json("https://huggingface.co/api/models/" + repo + ("/revision/" + revision if revision else "") + "?blobs=true")
    revision = data["sha"]
    files = []
    for item in data["siblings"]:
        filename = item["rfilename"]
        if selected is not None and filename not in selected:
            continue
        if selected is None and not filename.endswith((".onnx", ".data", ".json", ".model")):
            continue
        info = {"file": filename, "size": item.get("size"), "sha256": item.get("lfs", {}).get("sha256")}
        files.append(info)
        jobs.append((repo, revision, directory, info))
    record.append({"repository": repo, "revision": revision, "directory": directory, "files": files})
print("assets", len(jobs), "MB", round(sum(job[3]["size"] or 0 for job in jobs)/1e6, 1), flush=True)

def fetch(job):
    repo, revision, directory, info = job
    target = (MODELS / directory / info["file"]).resolve()
    if not target.is_relative_to((MODELS / directory).resolve()):
        raise RuntimeError("Model asset path escapes the experiment directory")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size == info["size"]:
        value = hashlib.sha256(target.read_bytes()).hexdigest()
        if not info["sha256"] or value == info["sha256"]:
            return {**info, "downloadSha256": value}
    part = target.with_name(target.name + ".part")
    url = "https://huggingface.co/" + repo + "/resolve/" + revision + "/" + info["file"]
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=45) as response, part.open("wb") as output:
        while chunk := response.read(1024*1024):
            output.write(chunk)
            digest.update(chunk)
    if part.stat().st_size != info["size"]:
        raise RuntimeError("incomplete model " + info["file"])
    if info["sha256"] and digest.hexdigest() != info["sha256"]:
        raise RuntimeError("checksum mismatch " + info["file"])
    part.replace(target)
    print("ready", directory, info["file"], flush=True)
    return {**info, "downloadSha256": digest.hexdigest()}

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    outputs = list(pool.map(fetch, jobs))
for metadata, output in zip(jobs, outputs):
    directory = metadata[2]
    next(file for item in record if item["directory"] == directory for file in item["files"] if file["file"] == output["file"]).update(output)
(ROOT / "model-lock.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
print("model-lock.json saved", flush=True)
