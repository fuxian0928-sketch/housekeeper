import { StyledSelect } from './../../components/ui';
import { useEffect, useRef, useState } from 'react';
import { Camera, Eye, Mic, MonitorUp, Play, RotateCcw, Sparkles, Volume2 } from 'lucide-react';
import xiaoEAvatar from '../../assets/xiao-e-avatar.png';
import type { CompanionConfig, CompanionDeviceStatus, CompanionState } from './types';
import { probeCompanionDevices } from './device-probe';

const fallbackConfig: CompanionConfig = { enabled: false, alwaysOnTop: true, appearance: 'character', iconSize: 64, characterHeight: 240, opacity: 1, motion: 'full', launchAtStartup: false, idleHideMinutes: 0, mockMode: true };
const fallbackDevices: CompanionDeviceStatus = { microphone: 'pending', camera: 'pending', mode: 'mock', microphones: [], cameras: [] };
type Tab = 'appearance' | 'behavior' | 'devices' | 'voice';

export function CompanionSettings({ onError }: { onError: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>('appearance');
  const [config, setConfig] = useState(fallbackConfig);
  const [devices, setDevices] = useState(fallbackDevices);
  const [saved, setSaved] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationMessage, setCalibrationMessage] = useState('');
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const [voices, setVoices] = useState<Array<{ name: string; culture: string; gender: string; engine?: string }>>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreams = useRef<MediaStream[]>([]);
  const audioContext = useRef<AudioContext | null>(null);
  const meterFrame = useRef<number | null>(null);
  const native = Boolean(window.aiSecretary?.companion);

  const stopCalibration = () => {
    mediaStreams.current.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    mediaStreams.current = [];
    if (meterFrame.current !== null) window.cancelAnimationFrame(meterFrame.current);
    meterFrame.current = null;
    void audioContext.current?.close();
    audioContext.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setMicrophoneLevel(0);
    setCalibrating(false);
  };

  useEffect(() => {
    const api = window.aiSecretary?.companion;
    if (!api) {
      void probeCompanionDevices().then(setDevices);
      return;
    }
    void Promise.all([api.getConfig(), probeCompanionDevices(), api.listVoices()]).then(([nextConfig, nextDevices, nextVoices]) => {
      setConfig(nextConfig);
      setDevices(nextDevices);
      setVoices(nextVoices);
    }).catch(reason => onError(reason instanceof Error ? reason.message : '无法读取桌面小E配置。'));
  }, [onError]);

  useEffect(() => {
    const refresh = () => void probeCompanionDevices().then(setDevices);
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, []);

  useEffect(() => () => stopCalibration(), []);

  const save = async () => {
    try {
      const next = window.aiSecretary?.companion ? await window.aiSecretary.companion.updateConfig(config) : config;
      setConfig(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (reason) { onError(reason instanceof Error ? reason.message : '桌面小E配置保存失败。'); }
  };

  const simulate = (state: CompanionState) => void window.aiSecretary?.companion.setState(state);

  const testVoice = async () => {
    try {
      const result = await fetch('/api/speech/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好，我是小E。云端语音已经准备好了。' }) });
      const payload = await result.json() as { audioDataUrl?: string; message?: string };
      if (!result.ok || !payload.audioDataUrl) throw new Error(payload.message || '云端音色试听失败。');
      await new Audio(payload.audioDataUrl).play();
    } catch (reason) { onError(reason instanceof Error ? reason.message : '云端音色试听失败。'); }
  };

  const calibrateDevices = async () => {
    stopCalibration();
    setCalibrationMessage('正在申请摄像头和麦克风权限…');
    try {
      const audioConstraint: MediaTrackConstraints = config.microphoneDeviceId ? { deviceId: { exact: config.microphoneDeviceId } } : {};
      const videoConstraint: MediaTrackConstraints = config.cameraDeviceId ? { deviceId: { exact: config.cameraDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
      const [audioResult, videoResult] = await Promise.allSettled([
        navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false }),
        navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraint })
      ]);
      const audioStream = audioResult.status === 'fulfilled' ? audioResult.value : null;
      const videoStream = videoResult.status === 'fulfilled' ? videoResult.value : null;
      if (!audioStream && !videoStream) throw new Error('摄像头和麦克风均无法打开，请检查 Windows 隐私权限或设备占用。');
      mediaStreams.current = [audioStream, videoStream].filter((stream): stream is MediaStream => Boolean(stream));
      if (videoStream && videoRef.current) {
        videoRef.current.srcObject = videoStream;
        await videoRef.current.play();
      }
      if (audioStream) {
        const context = new AudioContext();
        audioContext.current = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(audioStream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        const updateMeter = () => {
          analyser.getByteTimeDomainData(samples);
          let energy = 0;
          for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
          setMicrophoneLevel(Math.min(100, Math.round(Math.sqrt(energy / samples.length) * 260)));
          meterFrame.current = window.requestAnimationFrame(updateMeter);
        };
        updateMeter();
      }
      const refreshed = await probeCompanionDevices();
      setDevices({ ...refreshed, microphone: audioStream ? 'ready' : refreshed.microphone, camera: videoStream ? 'ready' : refreshed.camera, mode: 'hardware' });
      setConfig(current => ({ ...current, mockMode: false }));
      setCalibrating(true);
      setCalibrationMessage(audioStream && videoStream ? '设备工作正常，请对着麦克风说话并检查预览画面。' : audioStream ? '麦克风正常，摄像头未能打开。' : '摄像头正常，麦克风未能打开。');
    } catch (reason) {
      stopCalibration();
      const message = reason instanceof Error ? reason.message : '设备校准失败。';
      setCalibrationMessage(message);
      onError(message);
    }
  };

  return <section className="companion-settings settings-section single-setting-section">
    <div className="settings-heading"><div><h2>桌面小E</h2><p>让小E常驻桌面，并管理摄像头、麦克风与轻交互。</p></div><span className="connection-state ready"><Sparkles size={13} />桌面功能就绪</span></div>
    <div className="companion-status-strip">
      <div className="companion-miniature"><img src={xiaoEAvatar} alt="小E头像" /><i /></div>
      <div><strong>桌面伴随窗口</strong><span>{native ? (config.enabled ? '已启用，可随时唤出' : '当前已暂停') : '网页预览模式'}</span></div>
      <button className="secondary-button" type="button" onClick={() => void window.aiSecretary?.companion.show()}><MonitorUp size={16} />显示小E</button>
    </div>
    <div className="companion-settings-layout">
      <nav className="connection-nav companion-settings-nav" aria-label="桌面小E设置类型">
        {([{ id: 'appearance', title: '形象与窗口', detail: '大小、透明度和动效', icon: Eye }, { id: 'behavior', title: '交互行为', detail: '置顶、启动和待机', icon: Sparkles }, { id: 'devices', title: '摄像头与麦克风', detail: '检测输入设备和画面', icon: Mic }, { id: 'voice', title: '语音与视觉', detail: '对话、播报和视觉模型', icon: Volume2 }] as const).map(item => <button type="button" key={item.id} aria-pressed={tab === item.id} onClick={() => setTab(item.id)}><item.icon size={18} /><span><strong>{item.title}</strong><small>{item.detail}</small></span></button>)}
        <p>这些配置只保存在当前电脑，不会同步到服务器。</p>
      </nav>
      <div className="companion-settings-detail">
        {tab === 'appearance' ? <div className="companion-setting-stack">
          <label className="companion-choice"><span><strong>桌面形态</strong><small>全身形象或精简头像图标</small></span><StyledSelect value={config.appearance} onChange={event => setConfig({ ...config, appearance: event.target.value as CompanionConfig['appearance'] })}><option value="character">全身小E</option><option value="icon">圆形头像</option></StyledSelect></label>
          {config.appearance === 'icon' ? <label><span><strong>图标大小</strong><small>头像图标的实际边长</small></span><output>{config.iconSize}px</output><input type="range" min="48" max="96" step="4" value={config.iconSize} onChange={event => setConfig({ ...config, iconSize: Number(event.target.value) })} /></label> : <label><span><strong>全身高度</strong><small>桌面形象从头到脚的实际高度</small></span><output>{config.characterHeight}px</output><input type="range" min="180" max="300" step="10" value={config.characterHeight} onChange={event => setConfig({ ...config, characterHeight: Number(event.target.value) })} /></label>}
          <label><span><strong>窗口透明度</strong><small>降低后更容易融入桌面</small></span><output>{Math.round(config.opacity * 100)}%</output><input type="range" min="0.65" max="1" step="0.05" value={config.opacity} onChange={event => setConfig({ ...config, opacity: Number(event.target.value) })} /></label>
          <label className="companion-choice"><span><strong>动态效果</strong><small>跟随系统减少动态效果设置</small></span><StyledSelect value={config.motion} onChange={event => setConfig({ ...config, motion: event.target.value as CompanionConfig['motion'] })}><option value="full">柔和动态</option><option value="reduced">精简动态</option></StyledSelect></label>
        </div> : null}
        {tab === 'behavior' ? <div className="companion-setting-stack">
          <label className="companion-toggle"><span><strong>启用桌面小E</strong><small>关闭后保留配置，仅隐藏伴随窗口</small></span><input type="checkbox" checked={config.enabled} onChange={event => setConfig({ ...config, enabled: event.target.checked })} /></label>
          <label className="companion-toggle"><span><strong>保持在其他窗口上方</strong><small>小E会停留在桌面工作的最上层</small></span><input type="checkbox" checked={config.alwaysOnTop} onChange={event => setConfig({ ...config, alwaysOnTop: event.target.checked })} /></label>
          <label className="companion-toggle"><span><strong>开机后自动出现</strong><small>登录 Windows 时启动 AI 秘书和桌面小E</small></span><input type="checkbox" checked={config.launchAtStartup} onChange={event => setConfig({ ...config, launchAtStartup: event.target.checked })} /></label>
          <label className="companion-choice"><span><strong>无操作后隐藏</strong><small>需要时可从托盘再次唤出</small></span><StyledSelect value={config.idleHideMinutes} onChange={event => setConfig({ ...config, idleHideMinutes: Number(event.target.value) })}><option value={0}>始终显示</option><option value={15}>15 分钟</option><option value={30}>30 分钟</option><option value={60}>1 小时</option></StyledSelect></label>
        </div> : null}
        {tab === 'devices' ? <div className="companion-devices">
          <div className="device-readiness"><span className={`device-icon ${devices.microphone === 'ready' ? 'ready' : devices.microphone === 'detected' ? 'detected' : ''}`}><Mic size={19} /></span><div><strong>麦克风</strong><small>{devices.microphone === 'ready' ? '声音输入正常' : devices.microphone === 'detected' ? `已发现 ${devices.microphones.length} 个输入设备` : '未发现可用麦克风'}</small></div><em>{devices.microphone === 'ready' ? '可用' : devices.microphone === 'detected' ? '待校准' : '未接入'}</em></div>
          <label className="device-select"><span>声音输入设备</span><StyledSelect value={config.microphoneDeviceId ?? ''} onChange={event => setConfig({ ...config, microphoneDeviceId: event.target.value })}><option value="">系统默认麦克风</option>{devices.microphones.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}</StyledSelect></label>
          <div className="device-readiness"><span className={`device-icon ${devices.camera === 'ready' ? 'ready' : devices.camera === 'detected' ? 'detected' : ''}`}><Camera size={19} /></span><div><strong>摄像头</strong><small>{devices.camera === 'ready' ? '视频画面正常' : devices.camera === 'detected' ? `已发现 ${devices.cameras.length} 个视频设备` : '未发现可用摄像头'}</small></div><em>{devices.camera === 'ready' ? '可用' : devices.camera === 'detected' ? '待校准' : '未接入'}</em></div>
          <label className="device-select"><span>视频输入设备</span><StyledSelect value={config.cameraDeviceId ?? ''} onChange={event => setConfig({ ...config, cameraDeviceId: event.target.value })}><option value="">系统默认摄像头</option>{devices.cameras.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}</StyledSelect></label>
          <div className={`hardware-calibration ${calibrating ? 'active' : ''}`}><div className="camera-preview"><video ref={videoRef} muted playsInline /><span>{calibrating && devices.camera === 'ready' ? '实时预览' : '校准后显示摄像头画面'}</span></div><div className="microphone-meter"><strong>麦克风输入</strong><div><i style={{ transform: `scaleX(${microphoneLevel / 100})` }} /></div><small>{calibrating ? `当前音量 ${microphoneLevel}%` : '校准时请正常说一句话'}</small></div><p role="status">{calibrationMessage || '检测会临时打开设备，离开页面后立即释放。'}</p><div><button className="primary-button" type="button" onClick={() => void calibrateDevices()}>{calibrating ? '重新校准' : '检测并校准'}</button>{calibrating ? <button className="secondary-button" type="button" onClick={stopCalibration}>停止预览</button> : null}</div></div>
          <div className="simulation-panel"><div><strong>状态反馈测试</strong><span>验证桌面小E在不同工作状态下的轻动效。</span></div><div>{(['idle', 'listening', 'thinking', 'speaking', 'notifying', 'camera'] as CompanionState[]).map(state => <button type="button" key={state} onClick={() => simulate(state)}>{state === 'idle' ? <RotateCcw size={14} /> : <Play size={14} />}{({ idle: '待机', listening: '聆听', thinking: '思考', speaking: '说话', notifying: '提醒', camera: '视觉', waking: '唤醒' } as Record<CompanionState, string>)[state]}</button>)}<button type="button" onClick={() => void probeCompanionDevices().then(setDevices)}><RotateCcw size={14} />重新枚举</button></div></div>
        </div> : null}
        {tab === 'voice' ? <div className="companion-setting-stack">
          <div className="companion-info-card"><strong>云端语音已与模型连接分开</strong><span>对话、视觉、语音识别和语音合成均在“设置 → 模型连接”中配置，两台电脑会读取服务器上的同一份配置。</span></div>
          <label className="companion-toggle"><span><strong>常驻语音唤醒</strong><small>待机时监听人声，识别到相近称呼后唤醒小E</small></span><input type="checkbox" checked={config.wakeWordEnabled !== false} onChange={event => setConfig({ ...config, wakeWordEnabled: event.target.checked })} /></label>
          <label className="companion-choice"><span><strong>唤醒词</strong><small>默认“小E小E”，也支持“小E”“小E啊”等相近说法</small></span><input value={config.wakeWord ?? '小E小E'} maxLength={24} onChange={event => setConfig({ ...config, wakeWord: event.target.value })} /></label>
          <label><span><strong>模糊识别灵敏度</strong><small>越高越不容易误唤醒</small></span><output>{Math.round((config.wakeWordThreshold ?? .66) * 100)}%</output><input type="range" min="45" max="95" step="1" value={Math.round((config.wakeWordThreshold ?? .66) * 100)} onChange={event => setConfig({ ...config, wakeWordThreshold: Number(event.target.value) / 100 })} /></label>
          <label className="companion-toggle"><span><strong>允许按需查看摄像头</strong><small>每轮只截取一帧，不保存原始图片</small></span><input type="checkbox" checked={config.cameraContextEnabled !== false} onChange={event => setConfig({ ...config, cameraContextEnabled: event.target.checked })} /></label>
          <label className="companion-choice"><span><strong>本地回退音色</strong><small>百炼 TTS 不可用时，自动改用 Windows 语音</small></span><StyledSelect value={config.voiceName ?? ''} onChange={event => setConfig({ ...config, voiceName: event.target.value })}>{voices.map(voice => <option key={voice.name} value={voice.name}>{voice.name} · {voice.culture}</option>)}</StyledSelect></label>
          <label><span><strong>播报速度</strong><small>0 为系统标准速度</small></span><output>{config.speechRate ?? 0}</output><input type="range" min="-3" max="3" step="1" value={config.speechRate ?? 0} onChange={event => setConfig({ ...config, speechRate: Number(event.target.value) })} /></label>
          <label><span><strong>播报音量</strong><small>由 Windows 扬声器输出</small></span><output>{config.speechVolume ?? 100}%</output><input type="range" min="20" max="100" step="5" value={config.speechVolume ?? 100} onChange={event => setConfig({ ...config, speechVolume: Number(event.target.value) })} /></label>
          <div className="voice-test-row"><button className="secondary-button" type="button" onClick={() => void testVoice()}>试听云端音色</button><span>单击桌面小E开始说话，再次单击可停止。</span></div>
        </div> : null}
        <footer className="companion-settings-actions"><span role="status">{saved ? '已保存到当前电脑' : config.mockMode ? '当前不会访问摄像头或麦克风' : ''}</span><button className="primary-button" type="button" onClick={() => void save()}>保存桌面小E</button></footer>
      </div>
    </div>
  </section>;
}
