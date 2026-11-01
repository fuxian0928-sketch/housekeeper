"""Import and version preflight only: never open audio or call cloud."""
import argparse
import contextlib
import importlib
import importlib.metadata
import os
import json
from pathlib import Path
import sys


def check(input_name=None, output_name=None, enumerate_only=False):
    if sys.version_info[:2] != (3, 11):
        return {"ready": False, "code": "VOICE_NATIVE_PYTHON_VERSION"}
    requirements = Path(__file__).with_name("requirements.txt").read_text("utf-8")
    for line in requirements.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        name, expected = line.strip().split("==")
        try:
            if importlib.metadata.version(name) != expected:
                return {"ready": False, "code": "VOICE_NATIVE_DEPENDENCY_VERSION"}
        except importlib.metadata.PackageNotFoundError:
            return {"ready": False, "code": "VOICE_NATIVE_DEPENDENCY_MISSING"}
    # Import the actual worker graph, not just package metadata. DLL errors fail here.
    importlib.import_module("run_duplex")
    if enumerate_only:
        from device_selection import list_devices, VoiceDeviceError
        try:
            return {"ready": True, "devices": list_devices(importlib.import_module("sounddevice"))}
        except VoiceDeviceError as error:
            return {"ready": False, "code": str(error)}
    if input_name is not None or output_name is not None:
        from device_selection import select_pair, VoiceDeviceError
        try:
            select_pair(importlib.import_module("sounddevice"), input_name, output_name)
        except VoiceDeviceError as error:
            return {"ready": False, "code": str(error)}
    return {"ready": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-name")
    parser.add_argument("--output-name")
    parser.add_argument("--list-devices", action="store_true")
    args = parser.parse_args()
    try:
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = check(args.input_name, args.output_name, args.list_devices)
    except Exception:
        result = {"ready": False, "code": "VOICE_NATIVE_DEPENDENCY_LOAD"}
    print(json.dumps(result))
    sys.exit(0 if result["ready"] else 1)
