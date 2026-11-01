const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('aiSecretary', {
  computer:{status:()=>ipcRenderer.invoke('computer:status'),connect:()=>ipcRenderer.invoke('computer:connect'),disconnect:()=>ipcRenderer.invoke('computer:disconnect'),setFocus:target=>ipcRenderer.invoke('assistant:set-focus',target),onNavigate:listener=>subscribe('assistant:navigate',listener),onVoiceActivity:listener=>subscribe('assistant:voice-activity',listener)},
  installLatestUpdate: () => ipcRenderer.invoke('app:install-latest-update'),
  companion: {
    getConfig: () => ipcRenderer.invoke('companion:get-config'),
    voicePreferenceHistory: () => ipcRenderer.invoke('companion:voice-preference-history'),
    voicePreferenceVersion: id => ipcRenderer.invoke('companion:voice-preference-version',id),
    defaultVoicePreferences: () => ipcRenderer.invoke('companion:default-voice-preferences'),
    exportVoicePreferences: () => ipcRenderer.invoke('companion:export-voice-preferences'),
    previewVoicePreferences: text => ipcRenderer.invoke('companion:preview-voice-preferences',text),
    importVoicePreferences: text => ipcRenderer.invoke('companion:import-voice-preferences',text),
    previewNativeVoice: () => ipcRenderer.invoke('companion:preview-native-voice'),
    nativeControl: action => ipcRenderer.invoke('companion:native-control', action),
    captureCameraFrame:question=>ipcRenderer.invoke('companion:request-camera-frame',question),
    onCameraFrameRequest:listener=>subscribe('companion:capture-camera',listener),
    sendCameraFrame:(id,frame)=>ipcRenderer.send('companion:camera-frame',{id,frame}),
    listNativeDevices: () => ipcRenderer.invoke('companion:list-native-devices'),
    saveNativeDevices: value => ipcRenderer.invoke('companion:save-native-devices', value),
    clearVoiceLatency: () => ipcRenderer.invoke('companion:clear-voice-latency'),
    voiceLatency: () => ipcRenderer.invoke('companion:voice-latency'),
    voiceKeyStatus: () => ipcRenderer.invoke('companion:voice-key-status'),
    voiceKeyRevisions: () => ipcRenderer.invoke('companion:voice-key-revisions'),
    beginVoiceConnectionSave: () => ipcRenderer.invoke('companion:begin-voice-connection-save'),
    endVoiceConnectionSave: token => ipcRenderer.invoke('companion:end-voice-connection-save', token),
    voiceRuntimeStatus: () => ipcRenderer.invoke('companion:voice-runtime-status'),
    testNativeVoiceConnection: draft => ipcRenderer.invoke('companion:test-native-voice-connection', draft),
    setVoiceEnabled: enabled => ipcRenderer.invoke('companion:set-voice-enabled', enabled),
    saveVoiceKey: (purpose, value) => ipcRenderer.invoke('companion:save-voice-key', purpose, value),
    updateConfig: (changes) => ipcRenderer.invoke('companion:update-config', changes),
    getState: () => ipcRenderer.invoke('companion:get-state'),
    setState: (state) => ipcRenderer.invoke('companion:set-state', state),
    getDeviceStatus: () => ipcRenderer.invoke('companion:get-device-status'),
    show: () => ipcRenderer.invoke('companion:show'),
    hide: () => ipcRenderer.invoke('companion:hide'),
    openMain: (target) => ipcRenderer.invoke('companion:open-main', target),
    showContextMenu: () => ipcRenderer.invoke('companion:show-context-menu'),
    listVoices: () => ipcRenderer.invoke('companion:list-voices'),
    recognizeSpeech: () => ipcRenderer.invoke('companion:recognize-speech'),
    speak: (text) => ipcRenderer.invoke('companion:speak', text),
    stopSpeech: () => ipcRenderer.invoke('companion:stop-speech'),
    moveToPointer: (position) => ipcRenderer.send('companion:move-to-pointer', position),
    onStateChanged: (listener) => subscribe('companion:state-changed', listener),
    onPlaybackLevel: listener => subscribe('companion:playback-level', listener),
    voiceEngineStatus: () => ipcRenderer.invoke('companion:voice-engine-status'),
    saveVoiceEngine: engine => ipcRenderer.invoke('companion:save-voice-engine', engine),
    restartForVoiceEngine: () => ipcRenderer.invoke('companion:restart-for-voice-engine'),
    onConfigChanged: (listener) => subscribe('companion:config-changed', listener),
    onManualWake: (listener) => subscribe('companion:manual-wake', listener),
    onOpenSettings: (listener) => subscribe('companion:open-settings', listener)
  }
});
