"""Standalone installed-device diagnostic. Discards all input; outputs silence only.

Runs with the existing installed Python. Never imports the application database,
loads secrets, writes preferences, or sends anything over the network.
"""
import json
import os
import sys
import time


def describe_error(error):
    result = {"kind": type(error).__name__}
    values = getattr(error, "args", ())
    if len(values) > 1 and type(values[1]) is int:
        result["portAudioCode"] = values[1]
    if len(values) > 2 and isinstance(values[2], (tuple, list)) and len(values[2]) > 1 and type(values[2][1]) is int:
        result["hostErrorCode"] = values[2][1]
    return result


def check_devices(audio, select_pair, names, *, open_stream=False):
    devices, apis = audio.query_devices(), audio.query_hostapis()
    indexes = select_pair(audio, names.get("inputName", ""), names.get("outputName", ""))
    result = {"selectionAccepted": True, "streamChecked": False, "endpoints": []}
    for direction, index in zip(("input", "output"), indexes):
        row = devices[index]
        result["endpoints"].append({"direction": direction, "name": row["name"],
            "hostApi": apis[row["hostapi"]]["name"], "maxChannels": row["max_"+direction+"_channels"],
            "defaultSampleRate": row.get("default_samplerate")})
    if not open_stream:
        return result
    callbacks = [0]
    def callback(indata, outdata, frames, timestamps, status):
        # Read no samples from indata. Never play tones or synthesize speech.
        outdata.fill(0)
        callbacks[0] += 1
    began = time.perf_counter()
    try:
        with audio.Stream(device=indexes, samplerate=16000, channels=(1, 2), dtype='float32',
                blocksize=160, callback=callback, extra_settings=audio.WasapiSettings(auto_convert=True), latency='low'):
            audio.sleep(1800)
        result.update(streamChecked=True, streamOpened=True, callbacks=callbacks[0])
    except Exception as error:
        result.update(streamChecked=True, streamOpened=False, error=describe_error(error))
    result["elapsedMs"] = round((time.perf_counter()-began)*1000)
    return result


def main():
    encoded = os.environ.get('XIWEI_DIAGNOSTIC_INPUT') or sys.stdin.readline(20000)
    if len(encoded) > 20000:
        raise ValueError('DIAGNOSTIC_INPUT_LIMIT')
    args = json.loads(encoded)
    from pathlib import Path
    root = Path(args["workerRoot"]).resolve()
    sys.path.insert(0, str(root / "scripts/voice-lab"))
    import sounddevice
    from device_selection import select_pair
    try:
        result = check_devices(sounddevice, select_pair, args, open_stream=args.get("openStream") is True)
    except Exception as error:
        result = {"selectionAccepted": False, "error": describe_error(error)}
        # Selection uses fixed codes only. Do not return arbitrary exception text.
        if str(error) in ('VOICE_NATIVE_DEVICE_MISSING','VOICE_NATIVE_DEVICE_AMBIGUOUS','VOICE_NATIVE_DEVICE_CHANNELS','VOICE_NATIVE_DEVICE_ENUMERATION'):
            result["code"] = str(error)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({"selectionAccepted": False, "error": describe_error(error)}))
