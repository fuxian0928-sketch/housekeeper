// Device IDs can change after reconnecting a USB camera/microphone.
export async function acquireMicrophone(
  devices: Pick<MediaDevices, 'getUserMedia'>,
  deviceId?: string,
  onFallback?: () => void,
): Promise<MediaStream> {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    return await devices.getUserMedia({ audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio, video: false });
  } catch (error) {
    if (!deviceId || !['OverconstrainedError', 'NotFoundError'].includes((error as Error)?.name)) throw error;
    const stream = await devices.getUserMedia({ audio, video: false });
    onFallback?.();
    return stream;
  }
}
