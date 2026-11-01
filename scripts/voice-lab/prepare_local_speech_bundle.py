"""Build a separate personal bundle; never mutate the previous release or download models."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

def sha(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b""):
            value.update(chunk)
    return value.hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    if output.exists() or not output.is_relative_to(root / "outputs"):
        raise RuntimeError("A new directory inside workspace outputs is required")
    base = args.base.resolve()
    manifest = json.loads((base / "bundle.json").read_text(encoding="utf-8"))
    for item in manifest["files"]:
        source = (base / item["path"]).resolve()
        if not source.is_relative_to(base) or sha(source) != item["sha256"]:
            raise RuntimeError("Base bundle differs from its seal")
    shutil.copytree(base, output, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    speech = output / "speech-models"
    for name in ["asr", "MOSS-TTS-Nano-100M-ONNX", "MOSS-Audio-Tokenizer-Nano-ONNX"]:
        shutil.copytree(args.models / name, speech / name, ignore=shutil.ignore_patterns("__pycache__"))
    reference = json.loads(args.reference.read_text(encoding="utf-8"))
    if reference["referenceSha256"] != "d9a1bd9de87cceff2821e39cbdffcc866e633e78a41c7d54df9534e64370e771":
        raise RuntimeError("Selected reference differs from approved B")
    (speech / "xiwei-sweet-soft.json").write_text(json.dumps(reference, ensure_ascii=False, indent=2), encoding="utf-8")
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    resources = next(item for item in package["build"]["extraResources"] if item["to"] == "native-voice/scripts/voice-lab")
    for name in resources["filter"]:
        dest = output / "scripts/voice-lab" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / resources["from"] / name, dest)
    shutil.copy2(root / "scripts/voice-lab/xiao-e-keywords.txt", output / "keywords.txt")
    python = output / "python/python.exe"
    # Install in a short temporary path: Windows' long project directories exceed
    # pip's path limit in optional ONNX conversion tools. The inference C API does
    # not use those conversion/transformer utilities; keep licenses and metadata.
    with tempfile.TemporaryDirectory(prefix="xiwei-speech-") as temp:
        assert Path(temp).resolve().is_relative_to(Path(tempfile.gettempdir()).resolve())
        subprocess.run([str(python), "-E", "-s", "-B", "-m", "pip", "install", "--no-deps", "--no-compile", "--disable-pip-version-check", "--target", temp, "-r", str(root / "scripts/voice-lab/local-speech-requirements.txt")], check=True)
        def ignore(directory, names):
            return [name for name in names if name == "__pycache__" or (Path(directory).name == "onnxruntime" and name in ["tools", "transformers"]) or name.endswith(".pyc")]
        for dependency in Path(temp).iterdir():
            dest = output / "python/Lib/site-packages" / dependency.name
            if dependency.is_dir():
                shutil.copytree(dependency, dest, dirs_exist_ok=True, ignore=ignore)
            else:
                shutil.copy2(dependency, dest)
    (output / "third-party-notices/xiwei-local-speech.md").write_text(
        "# Xiwei local speech\n\nMOSS-TTS-Nano runtime: Apache-2.0, OpenMOSS.\n"
        "Runtime source SHA256: 99477efaff28c12c0c8e16a6b4aab4e880a70851693fa303d932415ba180cbd5.\n"
        "TTS weights: OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX @ f52645cb467506d8e18e746ddd59482685b74e58.\n"
        "Codec: OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX @ ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae.\n"
        "ASR: csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20 @ 98590b7ed6443e77b714204da2757d75e1a642f4.\n"
        "B voice reference was generated locally with Qwen3-TTS VoiceDesign; no real person reference.\n"
        "See scripts/voice-lab/licenses/MOSS-TTS-Nano-APACHE-2.0.txt and package dist-info licenses.\n",
        encoding="utf-8")
    files = []
    for file in sorted(output.rglob("*")):
        if not file.is_file() or file.name == "bundle.json":
            continue
        if file.is_symlink():
            raise RuntimeError("Symlink not allowed")
        files.append({"path": file.relative_to(output).as_posix(), "bytes": file.stat().st_size, "sha256": sha(file)})
    manifest.update({"localSpeech": {"voice":"xiwei-sweet-soft","sampleRate":16000,"channels":1}, "files":files})
    (output / "bundle.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"bundle":str(output),"files":len(files),"bytes":sum(item["bytes"] for item in files),"voice":"xiwei-sweet-soft"}), flush=True)

if __name__ == "__main__":
    main()
