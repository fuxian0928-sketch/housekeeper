function voiceSettingsSenderFailure(event, mainWindow, appPort) {
  const frame = event?.senderFrame;
  const senderId = event?.sender?.id;
  const mainId = mainWindow?.webContents?.id;
  const frameId = frame?.frameTreeNodeId;
  const mainFrameId = mainWindow?.webContents?.mainFrame?.frameTreeNodeId;
  if (!mainWindow) return 'window-missing';
  // Both IDs are supplied by Electron, not by renderer code. Depending on the
  // Electron version, event.sender can be a different WebContents wrapper;
  // the globally unique main-frame node remains the ownership proof.
  const sameWebContents = Number.isSafeInteger(senderId) && Number.isSafeInteger(mainId) && senderId === mainId;
  const sameMainFrame = Number.isSafeInteger(frameId) && Number.isSafeInteger(mainFrameId) && frameId === mainFrameId;
  if (!sameWebContents && !sameMainFrame) return 'window-id';
  if (!frame || frame.detached) return 'frame';
  // Electron may return distinct JS wrappers for the same WebContents and
  // main frame. Stable IDs establish window ownership; parent and origin
  // still prevent a subframe or another page from invoking privileged IPC.
  if (frame.parent != null) return 'subframe';
  try {
    return new URL(frame.url).origin === `http://127.0.0.1:${appPort}` ? null : 'origin';
  } catch {
    return 'origin';
  }
}

function isVoiceSettingsSender(event, mainWindow, appPort) {
  return voiceSettingsSenderFailure(event, mainWindow, appPort) === null;
}

module.exports = { isVoiceSettingsSender, voiceSettingsSenderFailure };
