import type { CompanionDeviceStatus } from './types';

export async function probeCompanionDevices(): Promise<CompanionDeviceStatus> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { microphone: 'unavailable', camera: 'unavailable', mode: 'mock', microphones: [], cameras: [] };
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphones = devices.filter(device => device.kind === 'audioinput').map((device, index) => ({ id: device.deviceId, label: device.label || `麦克风 ${index + 1}` }));
    const cameras = devices.filter(device => device.kind === 'videoinput').map((device, index) => ({ id: device.deviceId, label: device.label || `摄像头 ${index + 1}` }));
    return {
      microphone: microphones.length ? 'detected' : 'pending',
      camera: cameras.length ? 'detected' : 'pending',
      mode: microphones.length || cameras.length ? 'hardware' : 'mock',
      microphones,
      cameras
    };
  } catch {
    return { microphone: 'unavailable', camera: 'unavailable', mode: 'mock', microphones: [], cameras: [] };
  }
}
