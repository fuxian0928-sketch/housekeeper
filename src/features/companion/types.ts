export type CompanionState = 'idle' | 'waking' | 'listening' | 'thinking' | 'speaking' | 'notifying' | 'camera';

export type CompanionMotion = 'full' | 'reduced';

export interface CompanionConfig {
  enabled: boolean;
  alwaysOnTop: boolean;
  appearance: 'icon' | 'character';
  iconSize: number;
  characterHeight: number;
  opacity: number;
  motion: CompanionMotion;
  launchAtStartup: boolean;
  idleHideMinutes: number;
  mockMode: boolean;
  microphoneDeviceId?: string;
  cameraDeviceId?: string;
  voiceName?: string;
  speechRate?: number;
  speechVolume?: number;
  cameraContextEnabled?: boolean;
  voiceChatModel?: string;
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

export interface CompanionApi {
  getConfig: () => Promise<CompanionConfig>;
  updateConfig: (changes: Partial<CompanionConfig>) => Promise<CompanionConfig>;
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
  onConfigChanged: (listener: (config: CompanionConfig) => void) => () => void;
  onOpenSettings: (listener: () => void) => () => void;
}
