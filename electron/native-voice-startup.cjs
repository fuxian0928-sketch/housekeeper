// Voice failure must not close the user's task/document application. Do not
// silently enable the legacy microphone owner or expose provider error strings.
async function startNativeVoiceSafely(createHost, { onFailure } = {}) {
  let host;
  try {
    host = await createHost();
    await host.reconcile();
    return { host, error: null };
  } catch (error) {
    try { await host?.close(); } catch {}
    const assetErrors = {
      VOICE_LOCAL_START_FAILED: '本机语音尚未启动：识别或希微 B 音色资源加载失败，请修复客户端本地语音资源。',
      VOICE_LOCAL_START_TIMEOUT: '本机语音模型准备超时，请关闭占用内存较多的程序后重试。',
      VOICE_LOCAL_RESOURCE_MISSING: '本机语音资源缺失，请安装包含本地识别和 B 音色的客户端。',
      VOICE_LOCAL_PROVIDER_MISSING: '本机语音接入不完整，请更新当前客户端。',
      VOICE_SETTINGS_SYNC_FAILED: '语音设置同步失败，请检查这台电脑与个人服务器的连接后重试。',
      WORKER_START_TIMEOUT: '音频设备启动超时，请检查麦克风权限、设备占用和系统音频服务后重新连接。',
      WORKER_RUNTIME_FAILED: '音频设备打开失败，请检查 Windows 麦克风权限、设备占用和音频驱动。连接诊断可查看具体错误。',
      WORKER_EXITED_BEFORE_READY: '语音进程在连接设备前退出，请运行连接诊断检查本机运行组件。',
      WORKER_SPAWN_FAILED: '本机语音进程未能启动，请检查客户端语音组件是否被系统或安全软件拦截。',
      AUDIO_CAPTURE_STALLED: '麦克风已打开但没有收到音频，请检查设备连接或驱动后重新连接。',
      VOICE_NATIVE_BUNDLE_INVALID: '原生语音尚未启动：语音资源包不完整或校验失败，请修复客户端语音组件后重试。',
      ASR_REALTIME_NOT_CONFIGURED: '原生语音尚未启动：请在模型连接中填写实时语音识别模型。',
      ASR_REALTIME_MODEL_UNSUPPORTED: '原生语音尚未启动：当前识别模型不支持此实时协议，请选择 Qwen3-ASR-Flash-Realtime 系列。',
      ASR_INVALID_OFFICIAL_ENDPOINT: '原生语音尚未启动：语音服务地址无效，请使用支持的千问官方 HTTPS 地址。',
      ASR_INVALID_ENDPOINT_PATH: '原生语音尚未启动：语音服务地址路径不受支持，请检查模型连接中的服务地址。',
      VOICE_INVALID_SYNTHESIS_CONFIG: '原生语音尚未启动：请检查 Qwen3 实时语音合成模型及对应音色配置。',
      VOICE_INVALID_SPEECH_RATE: '原生语音尚未启动：播报速度应为 0.5–2 倍，请重新保存语音设置。',
      VOICE_INVALID_PROGRESS_CONFIG: '原生语音尚未启动：过程播报设置无效，请重新保存提示方式和时间间隔。',
      VOICE_INVALID_MODE: '原生语音尚未启动：对话模式无效，请重新选择自动、工作或生活模式。',

      VOICE_NATIVE_WAKE_WORD_INVALID: '唤醒词未生效：请使用2–12个汉字或字母E。',
      VOICE_NATIVE_WAKE_PRONUNCIATION_UNSUPPORTED: '唤醒词未生效：当前模型不支持这个读音，请换一个称呼。',
      VOICE_NATIVE_DEVICE_MISSING: '原生语音尚未启动：选中的麦克风或音箱不可用，请连接设备或重新选择。',
      VOICE_NATIVE_DEVICE_AMBIGUOUS: '原生语音尚未启动：设备名称匹配到多个设备，请使用完整且唯一的名称。',
      VOICE_NATIVE_DEVICE_CHANNELS: '原生语音尚未启动：当前音箱不支持所需的双声道输出，请选择其他输出设备。',
      VOICE_NATIVE_DEVICE_ENUMERATION: '原生语音尚未启动：无法读取音频设备，请检查系统音频服务后重试。',
      VOICE_NATIVE_ASSET_MISSING: '原生语音尚未启动：本机语音资源缺失或不可读取，请修复语音资源后重试。',
      VOICE_NATIVE_ASSET_INVALID: '原生语音尚未启动：本机语音模型校验失败，请重新安装可信语音资源后重试。',
      VOICE_NATIVE_MANIFEST_INVALID: '原生语音尚未启动：语音资源清单损坏，请修复客户端后重试。'
    };
    const runtimeErrors = new Set(['VOICE_NATIVE_PYTHON_VERSION','VOICE_NATIVE_DEPENDENCY_VERSION','VOICE_NATIVE_DEPENDENCY_MISSING','VOICE_NATIVE_DEPENDENCY_LOAD','VOICE_NATIVE_RUNTIME_CHECK_FAILED','VOICE_NATIVE_RUNTIME_CHECK_TIMEOUT']);
    const message = runtimeErrors.has(error?.message) ? '原生语音尚未启动：本机语音运行环境检查失败，请修复语音运行组件后重试。' : Object.hasOwn(assetErrors, error?.message) ? assetErrors[error.message] : error?.message === 'VOICE_KEY_NOT_CONFIGURED'
      ? '原生语音尚未启动：本机密钥缺失或无法解密，请检查本机语音凭证配置。'
      : error?.message === '语音模型设置暂时无法同步，请检查个人服务器连接。' ? error.message
      : '原生语音尚未启动：请检查本机模型、设备及实时语音配置。';
    const code = Object.hasOwn(assetErrors, error?.message) || runtimeErrors.has(error?.message) || error?.message === 'VOICE_KEY_NOT_CONFIGURED' ? error.message : 'VOICE_STARTUP_FAILED';
    try { onFailure?.({ code, message }); } catch { /* Diagnostic storage must not prevent retrying. */ }
    return { host: null, error: message };
  }
}
module.exports = { startNativeVoiceSafely };
