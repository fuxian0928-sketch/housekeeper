export type CompanionState = 'idle' | 'waking' | 'listening' | 'thinking' | 'speaking' | 'notifying' | 'camera';

export type CompanionMotion = 'full' | 'reduced';

export interface CompanionConfig {
  nativeVoiceManaged?: boolean;
  nativeVoiceError?: string | null;
  nativeVoiceStarting?: boolean;
  deviceId?: string;
  enabled: boolean;
  voiceEnabled?: boolean;
  alwaysOnTop: boolean;
  appearance: 'icon' | 'character';
  iconSize: number;
  characterHeight: number;
  opacity: number;
  motion: CompanionMotion;
  launchAtStartup: boolean;
  idleHideMinutes: number;
  voiceIdleSeconds?: number;
  voiceMinSpeechMs?: number;
  voiceMaxUtteranceSeconds?: number;
  voicePrefetchEnabled?: boolean;
  voicePrefetchAttempts?: 1 | 2;
  voiceProgressMode?: 'off' | 'concise' | 'detailed';
  voiceProgressFirstMs?: number;
  voiceProgressIntervalMs?: number;
  voiceEndSilenceMs?: number;
  voiceBargeInEnabled?: boolean;
  mockMode: boolean;
  microphoneDeviceId?: string;
  cameraDeviceId?: string;
  cameraFollowSystemDefault?: boolean;
  voiceName?: string;
  speechRate?: number;
  voiceSpeechRate?: number;
  voiceContinuousEnabled?: boolean;
  voiceFarewellText?: string;
  voiceNoiseSuppression?: boolean;
  voiceAutoGain?: boolean;
  voiceEchoDelayMs?: number;
  speechVolume?: number;
  cameraContextEnabled?: boolean;
  voiceChatModel?: string;
  voiceReasoningEffort?: 'follow' | 'auto' | 'low' | 'medium' | 'high';
  voiceAnswerConfigured?: boolean;
  voiceRoutingMode?: 'life' | 'work' | 'auto';
  voiceProjectId?: string;
  visionModel?: string;
  wakeWordEnabled?: boolean;
  wakeWord?: string;
  wakeWordThreshold?: number;
  position?: { x: number; y: number; displayId?: string };
}

export interface CompanionMediaDevice {
  id: string;
  label: string;
}

export interface CompanionDeviceStatus {
  microphone: 'unavailable' | 'pending' | 'detected' | 'ready';
  camera: 'unavailable' | 'pending' | 'detected' | 'ready';
  mode: 'mock' | 'hardware';
  microphones: CompanionMediaDevice[];
  cameras: CompanionMediaDevice[];
}

export type NativeVoiceDevices = {inputs:Array<{name:string;available:boolean}>;outputs:Array<{name:string;available:boolean}>;selected:{inputName:string;outputName:string}};
export type VoiceLatencyReport = {available:boolean;turns:Array<{startedAt:string|null;status:'failed'|'cancelled'|'submitted'|'finished'|'pending';asrWaitMs:number|null;ttsConnectMs:number|null;answerFirstMs:number|null;ttsFirstMs:number|null;responseWaitMs:number|null}>};
export interface CompanionApi {
  clearVoiceLatency?: () => Promise<VoiceLatencyReport>;
  voiceLatency?: () => Promise<VoiceLatencyReport>;
  voiceEngineStatus?: () => Promise<{current:'native'|'legacy';requested:'native'|'legacy';available:boolean;locked:boolean;restartRequired:boolean}>;
  saveVoiceEngine?: (engine:'native'|'legacy') => Promise<{current:'native'|'legacy';requested:'native'|'legacy';available:boolean;locked:boolean;restartRequired:boolean}>;
  restartForVoiceEngine?: () => Promise<boolean>;
  listNativeDevices?: () => Promise<NativeVoiceDevices>;
  saveNativeDevices?: (value:{inputName:string;outputName:string}) => Promise<{saved:boolean;applied:boolean;error?:string}>;
  voicePreferenceHistory?: () => Promise<Array<{id:string;savedAt:string;adjustedLabels?:string[]}>>;
  voicePreferenceVersion?: (id:string) => Promise<string>;
  defaultVoicePreferences?: () => Promise<string>;
  exportVoicePreferences?: () => Promise<string>;
  previewVoicePreferences?: (text:string) => Promise<Array<{field:string;label:string;value:string|number|boolean}>>;
  importVoicePreferences?: (text:string) => Promise<CompanionConfig>;
  previewNativeVoice?: () => Promise<boolean>;
  nativeControl?: (action: 'wake' | 'dismiss') => Promise<boolean>;
  captureCameraFrame?:(question:string)=>Promise<string|null>;
  onCameraFrameRequest?:(listener:(request:{id:string;cancel:boolean})=>void)=>()=>void;
  sendCameraFrame?:(id:string,frame:string|null)=>void;
  voiceKeyStatus?: () => Promise<Record<'recognition' | 'synthesis', 'configured' | 'missing' | 'unreadable'>>;
  voiceKeyRevisions?: () => Promise<Record<'recognition' | 'synthesis', string>>;
  beginVoiceConnectionSave?: () => Promise<string | null>;
  endVoiceConnectionSave?: (token: string) => Promise<boolean>;
  voiceRuntimeStatus?: () => Promise<{ engine: 'native' | 'legacy'; enabled: boolean; starting?: boolean; running: boolean | null; error: string | null }>;
  setVoiceEnabled?: (enabled: boolean) => Promise<{ enabled: boolean; mockMode?: boolean; running: boolean }>;
  saveVoiceKey?: (purpose: 'recognition' | 'synthesis', value: string) => Promise<Record<'recognition' | 'synthesis', 'configured' | 'missing' | 'unreadable'>>;
  getConfig: () => Promise<CompanionConfig>;
  updateConfig: (changes: Partial<CompanionConfig>) => Promise<CompanionConfig>;
  testNativeVoiceConnection?: (draft: { purpose: 'recognition' | 'synthesis'; url: string; model: string; voice: string; key: string }) => Promise<{ connected: boolean; stage: string; detail: string }>;
  getState: () => Promise<CompanionState>;
  setState: (state: CompanionState) => Promise<CompanionState>;
  getDeviceStatus: () => Promise<CompanionDeviceStatus>;
  show: () => Promise<void>;
  hide: () => Promise<void>;
  openMain: (target?: 'chat' | 'settings') => Promise<void>;
  showContextMenu: () => Promise<void>;
  listVoices: () => Promise<Array<{ name: string; id?: string; culture: string; gender: string; engine?: string }>>;
  recognizeSpeech: () => Promise<{ ok: boolean; text?: string; confidence?: number; error?: string; message?: string }>;
  speak: (text: string) => Promise<{ ok: boolean; error?: string; message?: string }>;
  stopSpeech: () => Promise<boolean>;
  moveToPointer: (position: { screenX: number; screenY: number; offsetX: number; offsetY: number }) => void;
  onStateChanged: (listener: (state: CompanionState) => void) => () => void;
  onPlaybackLevel?: (listener: (level: number) => void) => () => void;
  onConfigChanged: (listener: (config: CompanionConfig) => void) => () => void;
  onManualWake?: (listener: () => void) => () => void;
  onOpenSettings: (listener: () => void) => () => void;
}
