import { createQwenRealtimeAsr, qwenRealtimeUrl, type RealtimeAsrOptions } from './qwen-realtime-asr.js';

export type RealtimeRecognitionSettings = { speechServiceBaseUrl: string; speechRealtimeRecognitionModel?: string };
export type TrustedRecognitionSettings = { current(): RealtimeRecognitionSettings; effectiveApiKey(): string | null };

export function validateRealtimeRecognition(settings: RealtimeRecognitionSettings) {
  const model = settings.speechRealtimeRecognitionModel?.trim();
  if (!model) throw new Error('ASR_REALTIME_NOT_CONFIGURED');
  // Only this protocol family is implemented; a name containing "streaming" is insufficient.
  if (!/^qwen3-asr-flash-realtime(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) throw new Error('ASR_REALTIME_MODEL_UNSUPPORTED');
  const baseUrl = settings.speechServiceBaseUrl.trim();
  qwenRealtimeUrl(baseUrl, model);
  return { baseUrl, model };
}

/** Lives in the existing credential owner. No key export API, new key file, or renderer handoff. */
export function configuredRealtimeAsrFactory(settings: TrustedRecognitionSettings, connect = createQwenRealtimeAsr) {
  return (signal: AbortSignal, onPartial: NonNullable<RealtimeAsrOptions['onPartial']>) => {
    signal.throwIfAborted();
    const configuration = validateRealtimeRecognition(settings.current());
    const apiKey = settings.effectiveApiKey();
    if (!apiKey) throw new Error('ASR_KEY_NOT_CONFIGURED');
    // Snapshot each utterance. User changes apply to the next one, never midway through PCM.
    return connect({ ...configuration, apiKey, signal, onPartial });
  };
}
