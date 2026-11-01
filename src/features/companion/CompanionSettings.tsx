import {FeedbackBanner} from '../../components/FeedbackBanner';
import { VoiceExpressionSettings } from './VoiceExpressionSettings';
import { VoicePreferenceTransfer } from './VoicePreferenceTransfer';
import { VoiceEngineSettings } from './VoiceEngineSettings';
import { VoiceLatencySettings } from './VoiceLatencySettings';
import { NativeVoiceDeviceSettings } from './NativeVoiceDeviceSettings';
import { SessionExperienceSettings } from './SessionExperienceSettings';
import { StyledSelect } from './../../components/ui';
import { useEffect, useRef, useState } from 'react';
import { Camera, Eye, Mic, Play, RotateCcw, Sparkles, Volume2 } from 'lucide-react';
import type { CompanionConfig, CompanionDeviceStatus, CompanionState } from './types';
import type { AppSettings } from '../../types';
import { probeCompanionDevices } from './device-probe';
import { DEFAULT_VOICE_FAREWELL, readWakeWord } from '../../assistant-identity';
import {useWorkbenchActive, useWorkbenchDraft} from '../conversations/useWorkbenchTabs';
import {SceneSettings} from '../agent/SceneSettings';

const fallbackConfig: CompanionConfig = { enabled: true, voiceEnabled: true, alwaysOnTop: true, appearance: 'character', iconSize: 64, characterHeight: 240, opacity: 1, motion: 'full', launchAtStartup: false, idleHideMinutes: 0, mockMode: true };
const fallbackDevices: CompanionDeviceStatus = { microphone: 'pending', camera: 'pending', mode: 'mock', microphones: [], cameras: [] };
type VoiceSection = 'devices' | 'wake' | 'mode' | 'feedback' | 'advanced';

type Tab = 'appearance' | 'behavior' | 'devices' | 'voice';

export function CompanionSettings({ onError, settings, onOpenModel }: { onError: (message: string) => void; settings: AppSettings; startOnVoiceDevices?: boolean; onOpenModel: (purpose: 'chat' | 'asr' | 'tts') => void }) {
  const [tab, setTab] = useState<Tab>('voice');
  const [voiceSection, setVoiceSection] = useState<VoiceSection>('devices');
  const [config, setConfig] = useState(fallbackConfig);
  const [savedConfig,setSavedConfig] = useState(fallbackConfig);
  const [devices, setDevices] = useState(fallbackDevices);
  const [saved, setSaved] = useState(false);
  const [voiceSwitchBusy, setVoiceSwitchBusy] = useState(false);
  const [voiceSwitchMessage, setVoiceSwitchMessage] = useState('');
  const [voiceRuntime,setVoiceRuntime]=useState<{enabled:boolean;starting?:boolean;running:boolean|null;error:string|null}|null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationMessage, setCalibrationMessage] = useState('');
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const [voices, setVoices] = useState<Array<{ name: string; culture: string; gender: string; engine?: string }>>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectError, setProjectError] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const mediaStreams = useRef<MediaStream[]>([]);
  const audioContext = useRef<AudioContext | null>(null);
  const meterFrame = useRef<number | null>(null);
  const native = Boolean(window.aiSecretary?.companion);
  const active = useWorkbenchActive();
  useWorkbenchDraft('companion-settings',JSON.stringify(config)!==JSON.stringify(savedConfig),voiceSwitchBusy);

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
    let active = true;
    void api.getConfig().then(nextConfig => { if (active) {setConfig(nextConfig);setSavedConfig(nextConfig);} }).catch(reason => onError(reason instanceof Error ? reason.message : '无法读取桌面希微配置。'));
    void probeCompanionDevices().then(nextDevices => { if (active) setDevices(nextDevices); });
    void api.listVoices().then(nextVoices => { if (active) setVoices(nextVoices); })
      .catch(() => { if (active) setVoices([]); });
    return () => { active = false; };
  }, [onError]);

  useEffect(() => {
    const refresh = () => void probeCompanionDevices().then(setDevices);
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, []);

  useEffect(() => () => stopCalibration(), []);
  useEffect(() => {if (!active) stopCalibration();}, [active]);
  useEffect(()=>{
    const api=window.aiSecretary?.companion;
    if(!active||tab!=='voice'||!api?.voiceRuntimeStatus)return;
    let live=true;
    const refresh=()=>void api.voiceRuntimeStatus!().then(value=>{if(live)setVoiceRuntime(value);}).catch(()=>{});
    refresh();const timer=setInterval(refresh,2000);
    return()=>{live=false;clearInterval(timer);};
  },[active,tab]);

  useEffect(() => {
    if (tab !== 'voice') return;
    const controller = new AbortController();
    setProjectError('');
    void fetch('/api/projects', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('无法读取工作项目，请检查服务连接后重新进入此页。');
      const data = await response.json() as Array<{ id: string; name: string }>;
      if (!controller.signal.aborted) setProjects(data.filter(project => project.id !== 'system-voice-conversations'));
    }).catch(error => { if (!controller.signal.aborted) setProjectError(error instanceof Error ? error.message : '无法读取工作项目。'); });
    return () => controller.abort();
  }, [tab]);

  const save = async () => {
    try {
      // The answer model is edited in Model Connections; this page must not
      // write a stale copy back over a separately saved voice model choice.
      const { voiceChatModel: _voiceChatModel, voiceReasoningEffort: _voiceReasoningEffort, voiceAnswerConfigured: _voiceAnswerConfigured, ...changes } = config;
      const {voiceEnabled:_voiceEnabled,mockMode:_mockMode,...nativeChanges}=changes;
      const next = window.aiSecretary?.companion ? await window.aiSecretary.companion.updateConfig(config.nativeVoiceManaged?nativeChanges:changes) : config;
      setConfig(next);
      setSavedConfig(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (reason) { onError(reason instanceof Error ? reason.message : '桌面希微配置保存失败。'); }
  };

  const toggleVoice = async (enabled: boolean) => {
    const api = window.aiSecretary?.companion;
    if (!api?.setVoiceEnabled || voiceSwitchBusy) return;
    setVoiceSwitchBusy(true);
    setVoiceSwitchMessage('正在检查语音状态…');
    try {
      const result = await api.setVoiceEnabled(enabled);
      const updateFlags=(current:CompanionConfig)=>({...current,voiceEnabled:result.enabled,mockMode:result.mockMode??(result.enabled&&current.nativeVoiceManaged?false:current.mockMode)});
      setConfig(updateFlags);
      setSavedConfig(updateFlags);
      setVoiceSwitchMessage(result.running ? '语音已开启，正在监听。' : result.enabled ? '语音已开启，但当前处理方式未报告监听；请检查设备与诊断。' : '语音已暂停，监听已停止。');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '语音状态未改变，请重试。';
      setVoiceSwitchMessage(message);
      onError(message);
    } finally { setVoiceSwitchBusy(false); }
  };

  const simulate = (state: CompanionState) => void window.aiSecretary?.companion.setState(state);

  const testVoice = async () => {
    try {
      if (config.nativeVoiceManaged) {
        if (!await window.aiSecretary?.companion.previewNativeVoice?.()) throw new Error('请先启用原生语音、关闭设备模拟，并检查输入输出设备和语音连接。');
        return;
      }
      const result = await fetch('/api/speech/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好，我是希微。云端语音已经准备好了。' }) });
      const payload = await result.json() as { audioDataUrl?: string; message?: string };
      if (!result.ok || !payload.audioDataUrl) throw new Error(payload.message || '云端音色试听失败。');
      await new Audio(payload.audioDataUrl).play();
    } catch (reason) { onError(reason instanceof Error ? reason.message : '云端音色试听失败。'); }
  };

  const calibrateDevices = async (kind: 'camera' | 'microphone') => {
    stopCalibration();
    setCalibrationMessage(kind === 'camera' ? '正在申请摄像头权限…' : '正在申请麦克风权限…');
    try {
      const audioConstraint: MediaTrackConstraints = config.microphoneDeviceId ? { deviceId: { exact: config.microphoneDeviceId } } : {};
      const videoConstraint: MediaTrackConstraints = config.cameraFollowSystemDefault === false && config.cameraDeviceId ? { deviceId: { exact: config.cameraDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
      const audioStream = kind === 'microphone' ? await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false }) : null;
      const videoStream = kind === 'camera' ? await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraint }) : null;
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
      if (kind === 'microphone') setConfig(current => ({ ...current, mockMode: false }));
      setCalibrating(true);
      setCalibrationMessage(audioStream ? '麦克风正常，请说一句话观察输入电平。' : '摄像头正常，请检查预览画面。');
    } catch (reason) {
      stopCalibration();
      const message = reason instanceof Error ? reason.message : '设备校准失败。';
      setCalibrationMessage(message);
      onError(message);
    }
  };

  return <section className="companion-settings settings-section single-setting-section">
    <div className="settings-heading"><div><h2>桌面与语音</h2><p>人物场景、设备与对话。</p></div><span className="connection-state"><Sparkles size={13} />本机设置</span></div>
    <div className="companion-settings-layout">
      <nav className="connection-nav companion-settings-nav" aria-label="桌面希微设置类型">
        <p className="companion-nav-group">桌面显示</p>
        {([{ id: 'appearance', title: '形象与场景', detail: '人物、圆形语音和动效', icon: Eye }, { id: 'behavior', title: '显示与启动', detail: '置顶、隐藏和开机启动', icon: Sparkles }, { id: 'devices', title: '摄像头', detail: '自动连接和检测画面', icon: Camera }] as const).map(item => <button type="button" key={item.id} aria-pressed={tab === item.id} onClick={() => { detailRef.current?.scrollTo(0, 0); stopCalibration(); setTab(item.id); }}><item.icon size={18} /><span><strong>{item.title}</strong><small>{item.detail}</small></span></button>)}
        <p className="companion-nav-group">语音对话</p>
        {([{ id: 'devices', title: '设备与状态', detail: '麦克风、扬声器和检测', icon: Mic }, { id: 'wake', title: '唤醒与连续对话', detail: '唤醒、断句和待机', icon: Volume2 }, { id: 'mode', title: '对话模式', detail: '工作、生活和项目', icon: Sparkles }, { id: 'feedback', title: '打断与播报', detail: '音量、语速和过程提示', icon: Volume2 }, { id: 'advanced', title: '诊断与兼容', detail: '处理方式与运行诊断', icon: Eye }] as const).map(item => <button type="button" key={'voice-'+item.id} aria-pressed={tab === 'voice' && voiceSection === item.id} onClick={() => { detailRef.current?.scrollTo(0, 0); stopCalibration(); setTab('voice'); setVoiceSection(item.id); }}><item.icon size={18} /><span><strong>{item.title}</strong><small>{item.detail}</small></span></button>)}
        <p>设备与语音偏好保存在当前电脑；会话感受设置由服务端管理。</p>
      </nav>
      <div className="companion-settings-detail" ref={detailRef}>
        {tab === 'appearance' ? <><SceneSettings/><details className="settings-help"><summary>桌面悬浮窗</summary><div className="companion-setting-stack">
          <label className="companion-choice"><span><strong>桌面形态</strong><small>全身形象或精简头像图标</small></span><StyledSelect value={config.appearance} onChange={event => setConfig({ ...config, appearance: event.target.value as CompanionConfig['appearance'] })}><option value="character">全身希微</option><option value="icon">圆形头像</option></StyledSelect></label>
          {config.appearance === 'icon' ? <label><span><strong>图标大小</strong><small>头像图标的实际边长</small></span><output>{config.iconSize}px</output><input type="range" min="48" max="96" step="4" value={config.iconSize} onChange={event => setConfig({ ...config, iconSize: Number(event.target.value) })} /></label> : <label><span><strong>全身高度</strong><small>桌面形象从头到脚的实际高度</small></span><output>{config.characterHeight}px</output><input type="range" min="180" max="300" step="10" value={config.characterHeight} onChange={event => setConfig({ ...config, characterHeight: Number(event.target.value) })} /></label>}
          <label><span><strong>窗口透明度</strong><small>降低后更容易融入桌面</small></span><output>{Math.round(config.opacity * 100)}%</output><input type="range" min="0.65" max="1" step="0.05" value={config.opacity} onChange={event => setConfig({ ...config, opacity: Number(event.target.value) })} /></label>
          <label className="companion-choice"><span><strong>动态效果</strong><small>跟随系统减少动态效果设置</small></span><StyledSelect value={config.motion} onChange={event => setConfig({ ...config, motion: event.target.value as CompanionConfig['motion'] })}><option value="full">柔和动态</option><option value="reduced">精简动态</option></StyledSelect></label>
        </div></details></> : null}
        {tab === 'behavior' ? <div className="companion-setting-stack">
          <label className="companion-toggle"><span><strong>显示桌面希微</strong><small>关闭只隐藏形象；已开启的语音继续监听</small></span><input type="checkbox" checked={config.enabled} onChange={event => setConfig({ ...config, enabled: event.target.checked })} /></label>
          <label className="companion-toggle"><span><strong>保持在其他窗口上方</strong><small>希微会停留在桌面工作的最上层</small></span><input type="checkbox" checked={config.alwaysOnTop} onChange={event => setConfig({ ...config, alwaysOnTop: event.target.checked })} /></label>
          <label className="companion-toggle"><span><strong>开机后自动出现</strong><small>登录 Windows 时启动希微和桌面形象</small></span><input type="checkbox" checked={config.launchAtStartup} onChange={event => setConfig({ ...config, launchAtStartup: event.target.checked })} /></label>
          <label className="companion-choice"><span><strong>无操作后隐藏</strong><small>需要时可从托盘再次唤出</small></span><StyledSelect value={config.idleHideMinutes} onChange={event => setConfig({ ...config, idleHideMinutes: Number(event.target.value) })}><option value={0}>始终显示</option><option value={15}>15 分钟</option><option value={30}>30 分钟</option><option value={60}>1 小时</option></StyledSelect></label>
        </div> : null}
        {tab === 'devices' ? <div className="companion-devices">
          <div className="device-readiness"><span className={`device-icon ${devices.camera === 'ready' ? 'ready' : devices.camera === 'detected' ? 'detected' : ''}`}><Camera size={19} /></span><div><strong>摄像头</strong><small>{devices.camera === 'ready' ? '视频画面正常' : devices.camera === 'detected' ? `已发现 ${devices.cameras.length} 个视频设备` : '未发现可用摄像头'}</small></div><em>{devices.camera === 'ready' ? '可用' : devices.camera === 'detected' ? '待校准' : '未接入'}</em></div>
          <label className="device-select"><span>视频输入设备</span><StyledSelect value={config.cameraFollowSystemDefault === false ? config.cameraDeviceId ?? '' : ''} onChange={event => setConfig({ ...config, cameraDeviceId: event.target.value, cameraFollowSystemDefault: !event.target.value })}><option value="">系统默认摄像头</option>{devices.cameras.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}</StyledSelect></label>
          <div className={`hardware-calibration ${calibrating ? 'active' : ''}`}><div className="camera-preview"><video ref={videoRef} muted playsInline /><span>{calibrating && devices.camera === 'ready' ? '实时预览' : '校准后显示摄像头画面'}</span></div><div className="microphone-meter" hidden><strong>麦克风输入</strong><div><i style={{ transform: `scaleX(${microphoneLevel / 100})` }} /></div><small>{calibrating ? `当前音量 ${microphoneLevel}%` : '校准时请正常说一句话'}</small></div><p role="status">{calibrationMessage || '检测会临时打开摄像头，离开页面后立即释放。'}</p><div><button className="primary-button" type="button" onClick={() => void calibrateDevices('camera')}>{calibrating ? '重新校准' : '检测并校准'}</button>{calibrating ? <button className="secondary-button" type="button" onClick={stopCalibration}>停止预览</button> : null}</div></div>
          <div className="simulation-panel"><div><strong>状态反馈测试</strong><span>验证桌面希微在不同工作状态下的轻动效。</span></div><div>{(['idle', 'listening', 'thinking', 'speaking', 'notifying', 'camera'] as CompanionState[]).map(state => <button type="button" key={state} onClick={() => simulate(state)}>{state === 'idle' ? <RotateCcw size={14} /> : <Play size={14} />}{({ idle: '待机', listening: '聆听', thinking: '思考', speaking: '说话', notifying: '提醒', camera: '视觉', waking: '唤醒' } as Record<CompanionState, string>)[state]}</button>)}<button type="button" onClick={() => void probeCompanionDevices().then(setDevices)}><RotateCcw size={14} />重新枚举</button></div></div>
        </div> : null}
        {tab === 'voice' ? <div className="companion-setting-stack">
          {voiceSection === 'devices' ? <div className="voice-settings-panel">
          <div className="voice-connection-summary"><div><strong>启用语音对话</strong><small>记住开关与设备，启动时自动恢复；隐藏桌面形象仍可唤醒。</small></div><label className="companion-toggle"><input aria-label="启用语音对话" type="checkbox" disabled={!native || voiceSwitchBusy} checked={config.voiceEnabled !== false} onChange={event => void toggleVoice(event.target.checked)} /></label></div>
          {voiceRuntime?<p role="status">{voiceRuntime.starting?'正在准备语音和已保存设备…':!voiceRuntime.enabled?'语音已暂停，下次启动保持关闭。':voiceRuntime.running?'语音已连接，使用已保存的麦克风和音箱。':voiceRuntime.error||'语音连接尚未就绪。'}</p>:null}
          {voiceSwitchMessage ? <p role="status">{voiceSwitchMessage}</p> : null}
          <div className="voice-connection-summary"><span>识别：{settings.speechExecution === 'local' ? '本机识别' : (config.nativeVoiceManaged ? settings.speechRealtimeRecognitionModel : settings.speechRecognitionModel) ? '已填写模型' : '未配置模型'}　回答：{config.voiceChatModel ? config.voiceChatModel : `跟随默认（${settings.model || '未配置'}）`}　合成：{settings.speechExecution === 'local' ? '希微 B 音色' : (config.nativeVoiceManaged ? settings.speechRealtimeSynthesisModel : settings.speechSynthesisModel) ? '已填写模型' : '未配置模型'}</span><button className="secondary-button" type="button" onClick={() => onOpenModel('asr')}>管理模型连接</button></div>
          {config.nativeVoiceManaged ? <NativeVoiceDeviceSettings /> : null}
          {!config.nativeVoiceManaged ? <>          <div className="device-readiness"><span className={`device-icon ${devices.microphone === 'ready' ? 'ready' : devices.microphone === 'detected' ? 'detected' : ''}`}><Mic size={19} /></span><div><strong>麦克风</strong><small>{devices.microphone === 'ready' ? '声音输入正常' : devices.microphone === 'detected' ? `已发现 ${devices.microphones.length} 个输入设备` : '未发现可用麦克风'}</small></div><em>{devices.microphone === 'ready' ? '可用' : devices.microphone === 'detected' ? '待校准' : '未接入'}</em></div>
          <label className="device-select"><span>声音输入设备</span><StyledSelect value={config.microphoneDeviceId ?? ''} onChange={event => setConfig({ ...config, microphoneDeviceId: event.target.value })}><option value="">系统默认麦克风</option>{devices.microphones.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}</StyledSelect></label>
<div className="hardware-calibration"><div className="microphone-meter"><strong>麦克风输入</strong><div><i style={{ transform: `scaleX(${microphoneLevel / 100})` }} /></div><small>{calibrating ? `当前音量 ${microphoneLevel}%` : '检测时请正常说一句话'}</small></div><p role="status">{calibrationMessage || '检测时临时打开麦克风，离开页面后释放。'}</p><button className="secondary-button" type="button" onClick={() => void calibrateDevices('microphone')}>检测麦克风</button>{calibrating ? <button className="secondary-button" type="button" onClick={stopCalibration}>停止检测</button> : null}</div></> : null}
          {!config.nativeVoiceManaged ? <div className="companion-info-card"><strong>语音音箱</strong><span>兼容语音跟随 Windows 当前默认输出设备；此链路暂不支持单独指定音箱。</span><button className="secondary-button" type="button" onClick={() => void testVoice()}>试听当前输出</button></div> : null}
          {config.nativeVoiceError ? <FeedbackBanner tone="error">{config.nativeVoiceError}</FeedbackBanner> : null}
          {config.nativeVoiceManaged ? <section className="companion-info-card voice-processing-settings" aria-label="麦克风声音处理"><strong>麦克风声音处理</strong><p>保存后需要重新连接语音才能生效；回声消除始终开启。</p>
            <label><span>麦克风降噪</span><input type="checkbox" checked={config.voiceNoiseSuppression ?? false} onChange={event => setConfig({ ...config, voiceNoiseSuppression: event.target.checked })} /></label>
            <label><span>自动增益</span><input type="checkbox" checked={config.voiceAutoGain ?? false} onChange={event => setConfig({ ...config, voiceAutoGain: event.target.checked })} /></label>
            <label><span>回声延迟 · {config.voiceEchoDelayMs ?? 44} 毫秒</span><input aria-label="回声延迟" type="range" min="0" max="250" step="1" value={config.voiceEchoDelayMs ?? 44} onChange={event => setConfig({ ...config, voiceEchoDelayMs: Number(event.target.value) })} /></label>
            <small>降噪用于稳定背景噪声；自动增益用于说话忽大忽小的情况，也可能放大底噪。回声延迟用于输入与播放参考对齐，建议先保留 44 毫秒。</small>
          </section> : null}
          </div> : null}
          {voiceSection === 'wake' ? <div className="voice-settings-panel">

          <label className="companion-toggle"><span><strong>常驻语音唤醒</strong><small>待机时监听人声，识别到相近称呼后唤醒希微</small></span><input type="checkbox" checked={config.wakeWordEnabled !== false} onChange={event => setConfig({ ...config, wakeWordEnabled: event.target.checked })} /></label>
          <label className="companion-choice"><span><strong>唤醒词</strong><small>{config.nativeVoiceManaged ? '默认“希微希微”，也可叫“希微”；继续兼容旧称呼“小E”。支持2–12个汉字或字母E，保存后重新连接语音生效。' : '默认“希微希微”，也支持“希微”；继续兼容旧称呼“小E”。'}</small></span><input value={readWakeWord(config)} maxLength={24} onChange={event => setConfig({ ...config, wakeWord: event.target.value })} /></label>
          <label><span><strong>{config.nativeVoiceManaged ? '唤醒严格程度' : '模糊识别灵敏度'}</strong><small>{config.nativeVoiceManaged ? '越高越严格；这是调节档位，不是识别成功率。保存后重新连接语音生效。' : '越高越不容易误唤醒'}</small></span><output>{Math.round((config.wakeWordThreshold ?? .66) * 100)}%</output><input type="range" min="45" max="95" step="1" value={Math.round((config.wakeWordThreshold ?? .66) * 100)} onChange={event => setConfig({ ...config, wakeWordThreshold: Number(event.target.value) / 100 })} /></label>
          </div> : null}
          {voiceSection === 'wake' ? <div className="voice-settings-panel">
          {config.nativeVoiceManaged ? <label className="companion-toggle"><span><strong>连续对话</strong><small>开启时回答后继续听；关闭时每轮回答结束后待机，需要再次唤醒。保存后下次唤醒生效。</small></span><input aria-label="连续对话开关" type="checkbox" checked={config.voiceContinuousEnabled ?? true} onChange={event => setConfig({ ...config, voiceContinuousEnabled: event.target.checked })} /></label> : null}
{config.nativeVoiceManaged ? <>
            <label><span><strong>最短有效人声</strong><small>连续人声达到此时长后开始收音；结束时还会过滤累计不足约 320 毫秒的人声片段，减少键盘和呼吸声误触发。下次唤醒生效。</small></span><output>{config.voiceMinSpeechMs ?? 120} 毫秒</output><input aria-label="最短有效人声" type="range" min="50" max="500" step="1" value={config.voiceMinSpeechMs ?? 120} onChange={event => setConfig({ ...config, voiceMinSpeechMs: Number(event.target.value) })} /></label>
</> : null}
            {!config.nativeVoiceManaged ? <p className="muted">连续对话参数需要原生语音引擎。请在“设备与检测”中切换，重启后配置。</p> : null}
{config.nativeVoiceManaged ? <>
            <label className="companion-choice"><span><strong>无有效语音后待机</strong><small>保存后下次唤醒生效；到时先说告别语，再等待唤醒</small></span><StyledSelect aria-label="无有效语音后待机" value={config.voiceIdleSeconds ?? 300} onChange={event => setConfig({ ...config, voiceIdleSeconds: Number(event.target.value) })}>{![30,60,180,300,600,900,1800].includes(config.voiceIdleSeconds ?? 300) ? <option value={config.voiceIdleSeconds}>{config.voiceIdleSeconds} 秒（自定义）</option> : null}{[30,60,180,300,600,900,1800].map(seconds => <option key={seconds} value={seconds}>{seconds < 60 ? `${seconds} 秒` : `${seconds/60} 分钟`}{seconds === 300 ? '（默认）' : ''}</option>)}</StyledSelect></label>
</> : null}
{config.nativeVoiceManaged ? <>
            <label><span><strong>单次发言上限</strong><small>保存后下次唤醒生效；到限提示分段重说，不执行被截断的指令</small></span><output>{config.voiceMaxUtteranceSeconds ?? 30} 秒</output><input aria-label="单次发言上限" type="range" min="5" max="30" step="1" value={config.voiceMaxUtteranceSeconds ?? 30} onChange={event => setConfig({ ...config, voiceMaxUtteranceSeconds: Number(event.target.value) })} /></label>
</> : null}
{config.nativeVoiceManaged ? <>
            <label className="companion-choice"><span><strong>说话结束等待</strong><small>保存后下次唤醒生效；调长可减少停顿时被提前断句</small></span><StyledSelect aria-label="说话结束等待" value={config.voiceEndSilenceMs ?? 1000} onChange={event => setConfig({ ...config, voiceEndSilenceMs: Number(event.target.value) })}>{![300,500,800,1000,1500,2000,3000].includes(config.voiceEndSilenceMs ?? 1000) ? <option value={config.voiceEndSilenceMs}>{(config.voiceEndSilenceMs ?? 1000)/1000} 秒（自定义）</option> : null}{[300,500,800,1000,1500,2000,3000].map(ms => <option key={ms} value={ms}>{ms/1000} 秒{ms === 1000 ? '（默认）' : ''}</option>)}</StyledSelect></label>
</> : null}
          </div> : null}
          {voiceSection === 'feedback' ? <div className="voice-settings-panel">
            {!config.nativeVoiceManaged ? <p className="muted">打断与过程播报参数需要原生语音引擎。请在“设备与检测”中切换，重启后配置。</p> : null}
{config.nativeVoiceManaged ? <>
            <label className="companion-choice"><span><strong>工作过程播报</strong><small>下一轮生效；只说明实际进度，关闭不影响确认和最终回答</small></span><StyledSelect aria-label="工作过程播报" value={config.voiceProgressMode ?? 'concise'} onChange={event => setConfig({ ...config, voiceProgressMode: event.target.value as 'off' | 'concise' | 'detailed' })}><option value="off">关闭</option><option value="concise">简洁 · 每轮最多 3 次</option><option value="detailed">详细 · 每轮最多 5 次</option></StyledSelect></label>
</> : null}
{config.nativeVoiceManaged ? <>
            {(config.voiceProgressMode ?? 'concise') !== 'off' ? <>
              <label className="companion-choice"><span><strong>首次进度提示</strong><small>等待超过此时间才提示；快速完成时保持安静</small></span><StyledSelect aria-label="首次进度提示" value={config.voiceProgressFirstMs ?? 2000} onChange={event => setConfig({ ...config, voiceProgressFirstMs: Number(event.target.value) })}>{Array.from(new Set([1000,2000,3000,4000,5000,config.voiceProgressFirstMs ?? 2000])).sort((a,b)=>a-b).map(ms=><option key={ms} value={ms}>{ms/1000} 秒后</option>)}</StyledSelect></label>
              <label className="companion-choice"><span><strong>进度提示间隔</strong><small>两次提示至少相隔多久；状态未更新时不会反复播报</small></span><StyledSelect aria-label="进度提示间隔" value={config.voiceProgressIntervalMs ?? 8000} onChange={event => setConfig({ ...config, voiceProgressIntervalMs: Number(event.target.value) })}>{Array.from(new Set([5000,8000,10000,15000,20000,config.voiceProgressIntervalMs ?? 8000])).sort((a,b)=>a-b).map(ms=><option key={ms} value={ms}>{ms/1000} 秒</option>)}</StyledSelect></label>
            </> : null}
</> : null}
{config.nativeVoiceManaged ? <>
            <label className="companion-choice"><span><strong>说话打断希微</strong><small>保存后应用。关闭后，背景人声不会触发自动打断；仍可点击希微重新说话。</small></span><input type="checkbox" checked={config.voiceBargeInEnabled ?? true} onChange={event => setConfig({ ...config, voiceBargeInEnabled: event.target.checked })} /></label>
</> : null}
          </div> : null}
          {voiceSection === 'feedback' ? <div className="voice-settings-panel">
          {config.nativeVoiceManaged ? <label className="voice-farewell-setting"><span><strong>退下提示</strong><small>主动说“退下”或等待超时后播报，结束后需重新唤醒。修改后点击下方“保存桌面希微”。</small></span><input aria-label="退下提示" maxLength={120} value={config.voiceFarewellText ?? DEFAULT_VOICE_FAREWELL} onChange={event => setConfig({ ...config, voiceFarewellText: event.target.value })} /></label> : null}
          <div className="companion-info-card"><strong>声音服务在模型连接中配置</strong><span>此处只管理播放行为。识别、回答和合成的服务及密钥请到“模型连接”修改。</span></div>
          <label className="companion-choice"><span><strong>本地回退音色</strong><small>{config.nativeVoiceManaged ? '原生引擎暂不支持本地音色回退；云端失败时会显示错误' : '百炼 TTS 不可用时，自动改用 Windows 语音'}</small></span><StyledSelect disabled={config.nativeVoiceManaged} value={config.voiceName ?? ''} onChange={event => setConfig({ ...config, voiceName: event.target.value })}>{voices.map(voice => <option key={voice.name} value={voice.name}>{voice.name} · {voice.culture}</option>)}</StyledSelect></label>
          {settings.speechExecution === 'local' ? <p className="speech-location-note">本机音色使用 B 的自然语速，音量可单独调整。</p> : !config.nativeVoiceManaged ? <label><span><strong>播报速度</strong><small>0 为系统标准速度</small></span><output>{config.speechRate ?? 0}</output><input type="range" min="-3" max="3" step="1" value={config.speechRate ?? 0} onChange={event => setConfig({ ...config, speechRate: Number(event.target.value) })} /></label> : <label><span><strong>播报速度</strong><small>1 倍为标准语速，保存后从下一轮对话生效</small></span><output>{(config.voiceSpeechRate ?? 1).toFixed(2)} 倍</output><input aria-label="原生语音播报速度" type="range" min="0.5" max="2" step="0.05" value={config.voiceSpeechRate ?? 1} onChange={event => setConfig({ ...config, voiceSpeechRate: Number(event.target.value) })} /></label>}
          <label><span><strong>播报音量</strong><small>{config.nativeVoiceManaged ? '保存后从下一段播报生效，包含回答和过程提示；0%静音不会停止监听。' : '由 Windows 扬声器输出'}</small></span><output>{config.speechVolume ?? 100}%</output><input aria-label="播报音量" type="range" min="0" max="100" step="5" value={config.speechVolume ?? 100} onChange={event => setConfig({ ...config, speechVolume: Number(event.target.value) })} /></label>
          <div className="voice-test-row"><button className="secondary-button" type="button" onClick={() => void testVoice()}>试听云端音色</button><span>{config.nativeVoiceManaged ? '使用已保存的配置；会中止当前对话，试听后回到待机。' : '单击桌面希微开始说话，再次单击可停止。'}</span></div>
          </div> : null}
          {voiceSection === 'mode' ? <div className="voice-settings-panel">
          <VoiceExpressionSettings />
          <SessionExperienceSettings />
{config.nativeVoiceManaged ? <>
            <label className="companion-toggle"><span><strong>提前检索记忆</strong><small>实验功能，默认关闭：提速收益尚待验证，可能增加检索费用。保存后下一轮生效；关闭后仍会在回答时检索。</small></span><input type="checkbox" aria-label="提前检索记忆" checked={config.voicePrefetchEnabled === true} onChange={event => setConfig({ ...config, voicePrefetchEnabled: event.target.checked })} /></label>
</> : null}
{config.nativeVoiceManaged ? <>
            {config.voicePrefetchEnabled === true ? <label className="companion-choice"><span><strong>每轮提前检索次数</strong><small>只读取记忆，不执行任务；次数越多，越可能跟上说话内容的变化</small></span><StyledSelect aria-label="每轮提前检索次数" value={config.voicePrefetchAttempts ?? 2} onChange={event => setConfig({ ...config, voicePrefetchAttempts: Number(event.target.value) as 1 | 2 })}><option value="1">最多 1 次</option><option value="2">最多 2 次（默认）</option></StyledSelect></label> : null}
</> : null}
          <label className="companion-choice"><span><strong>对话模式</strong><small>保存后从下一轮生效，语音历史保持在同一段对话中</small></span><StyledSelect value={config.voiceRoutingMode ?? 'auto'} onChange={event => setConfig({ ...config, voiceRoutingMode: event.target.value as 'life' | 'work' | 'auto' })}><option value="life">生活</option><option value="work">工作</option><option value="auto">自动识别</option></StyledSelect></label>
          <label className="companion-choice"><span><strong>工作项目</strong><small>{(config.voiceRoutingMode ?? 'life') === 'life' ? '生活模式不读取工作项目' : '未指定项目时根据对话判断，信息不足时追问'}</small></span><StyledSelect disabled={(config.voiceRoutingMode ?? 'life') === 'life'} value={config.voiceProjectId ?? ''} onChange={event => setConfig({ ...config, voiceProjectId: event.target.value })}><option value="">根据对话判断</option>{config.voiceProjectId && !projects.some(project => project.id === config.voiceProjectId) ? <option value={config.voiceProjectId}>已选项目暂不可用，请重选</option> : null}{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</StyledSelect></label>
          {projectError ? <FeedbackBanner tone="error">{projectError}</FeedbackBanner> : null}
          <label className="companion-toggle"><span><strong>允许按需查看摄像头</strong><small>每轮只截取一帧，不保存原始图片</small></span><input type="checkbox" checked={config.cameraContextEnabled !== false} onChange={event => setConfig({ ...config, cameraContextEnabled: event.target.checked })} /></label>
          </div> : null}
          {voiceSection === 'advanced' ? <div className="voice-settings-panel">
            <VoiceEngineSettings />
            {config.nativeVoiceManaged ? <VoiceLatencySettings /> : null}
            {config.nativeVoiceManaged ? <VoicePreferenceTransfer onImported={value=>{setConfig(value);setSaved(true)}} /> : null}
          </div> : null}
        </div> : null}
        <footer className="companion-settings-actions"><span role="status">{saved ? '已保存到当前电脑' : config.mockMode ? '当前不会访问摄像头或麦克风' : ''}</span><button className="primary-button" type="button" onClick={() => void save()}>保存桌面希微</button></footer>
      </div>
    </div>
  </section>;
}
