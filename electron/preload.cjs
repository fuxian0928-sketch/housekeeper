const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('aiSecretary', {
  installLatestUpdate: () => ipcRenderer.invoke('app:install-latest-update'),
  companion: {
    getConfig: () => ipcRenderer.invoke('companion:get-config'),
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
    onConfigChanged: (listener) => subscribe('companion:config-changed', listener),
    onOpenSettings: (listener) => subscribe('companion:open-settings', listener)
  }
});
