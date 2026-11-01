"""Shared WASAPI endpoint selection; enumeration never opens an audio stream."""
class VoiceDeviceError(ValueError):
    pass

SYSTEM_DEFAULT = "__system_default__"


def select_endpoint(name, direction, devices, hostapis):
    if direction not in ("input", "output") or not isinstance(name, str) or not name.strip() or len(name) > 200:
        raise VoiceDeviceError("VOICE_NATIVE_DEVICE_MISSING")
    query = name.strip().casefold()
    if query == SYSTEM_DEFAULT:
        # Query the WASAPI host's default, not PortAudio's legacy MME default.
        defaults = [api.get(f"default_{direction}_device", -1) for api in hostapis
                    if api.get("name") == "Windows WASAPI"]
        if len(defaults) != 1 or not isinstance(defaults[0], int) or not 0 <= defaults[0] < len(devices):
            raise VoiceDeviceError("VOICE_NATIVE_DEVICE_MISSING")
        index, device = defaults[0], devices[defaults[0]]
        api_index = device.get("hostapi", -1)
        if not 0 <= api_index < len(hostapis) or hostapis[api_index].get("name") != "Windows WASAPI":
            raise VoiceDeviceError("VOICE_NATIVE_DEVICE_MISSING")
        if device.get(f"max_{direction}_channels", 0) < (2 if direction == "output" else 1):
            raise VoiceDeviceError("VOICE_NATIVE_DEVICE_CHANNELS")
        return index
    candidates = [(i, d) for i, d in enumerate(devices)
                  if d.get(f"max_{direction}_channels", 0) > 0
                  and 0 <= d.get("hostapi", -1) < len(hostapis)
                  and hostapis[d["hostapi"]].get("name") == "Windows WASAPI"]
    exact = [(i, d) for i, d in candidates if d.get("name", "").casefold() == query]
    matches = exact or [(i, d) for i, d in candidates if query in d.get("name", "").casefold()]
    if not matches:
        raise VoiceDeviceError("VOICE_NATIVE_DEVICE_MISSING")
    if len(matches) != 1:
        raise VoiceDeviceError("VOICE_NATIVE_DEVICE_AMBIGUOUS")
    index, device = matches[0]
    if device[f"max_{direction}_channels"] < (2 if direction == "output" else 1):
        raise VoiceDeviceError("VOICE_NATIVE_DEVICE_CHANNELS")
    return index


def select_pair(audio, input_name, output_name):
    try:
        devices, hostapis = audio.query_devices(), audio.query_hostapis()
    except Exception:
        raise VoiceDeviceError("VOICE_NATIVE_DEVICE_ENUMERATION") from None
    return (select_endpoint(input_name, "input", devices, hostapis),
            select_endpoint(output_name, "output", devices, hostapis))


def list_devices(audio):
    try:
        devices, apis = audio.query_devices(), audio.query_hostapis()
    except Exception:
        raise VoiceDeviceError("VOICE_NATIVE_DEVICE_ENUMERATION") from None
    result = {}
    for direction, key in (("input", "inputs"), ("output", "outputs")):
        names = list(dict.fromkeys(d["name"] for d in devices if d.get(f"max_{direction}_channels", 0) > 0 and apis[d["hostapi"]]["name"] == "Windows WASAPI"))
        result[key] = []
        try:
            select_endpoint(SYSTEM_DEFAULT, direction, devices, apis)
            default_available = True
        except VoiceDeviceError:
            default_available = False
        result[key].append({"name": SYSTEM_DEFAULT, "available": default_available})
        for name in names:
            if not name.strip() or len(name) > 200:
                continue
            try:
                select_endpoint(name, direction, devices, apis)
                available = True
            except VoiceDeviceError:
                available = False
            result[key].append({"name": name, "available": available})
        if len(result[key]) > 128:
            raise VoiceDeviceError("VOICE_NATIVE_DEVICE_ENUMERATION")
    return result
