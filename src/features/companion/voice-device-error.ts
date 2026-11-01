const messages: Record<string, string> = {
  VOICE_NATIVE_BUNDLE_INVALID: '语音组件缺失或损坏，无法读取设备。请修复或重新安装客户端语音组件。',
  VOICE_NATIVE_RUNTIME_CHECK_TIMEOUT: '读取设备超时，请稍后刷新；若持续超时，请检查系统音频服务。',
  VOICE_NATIVE_DEVICE_ENUMERATION: 'Windows 音频设备读取失败，请检查设备连接和系统音频服务后刷新。',
  VOICE_DEVICE_SELECTION_INVALID: '请选择麦克风和音箱后保存。',
  VOICE_DEVICE_SELECTION_UNAVAILABLE: '所选设备已断开或不可用，请刷新列表后重新选择。',
};

export function voiceDeviceErrorMessage(error: unknown): string {
  // Electron wraps rejected IPC errors. Never display arbitrary process output.
  const code = error instanceof Error ? error.message.match(/\bVOICE_[A-Z_]+\b/)?.[0] : undefined;
  return code && messages[code] || '语音运行环境检查失败，请修复客户端语音组件后重试。';
}
