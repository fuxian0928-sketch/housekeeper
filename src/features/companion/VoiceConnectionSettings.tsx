import {FeedbackBanner} from '../../components/FeedbackBanner';
import { useEffect, useState } from 'react';
import {useWorkbenchDraft} from '../conversations/useWorkbenchTabs';
import { api } from '../../api';
import type { AppSettings } from '../../types';

type Purpose = 'asr' | 'tts';
type Engine = 'native' | 'legacy';
type KeyStatus = 'configured' | 'missing' | 'unreadable';
type Draft = { url: string; model: string; voice: string; instruction: string; key: string };

function initial(settings: AppSettings, purpose: Purpose, engine: Engine): Draft {
  return engine === 'native'
    ? { url: purpose === 'asr' ? settings.speechServiceBaseUrl : settings.speechRealtimeSynthesisBaseUrl ?? '', model: purpose === 'asr' ? settings.speechRealtimeRecognitionModel ?? '' : settings.speechRealtimeSynthesisModel ?? '', voice: settings.speechRealtimeVoice ?? '', instruction: '', key: '' }
    : { url: purpose === 'asr' ? settings.speechLegacyRecognitionBaseUrl ?? settings.speechServiceBaseUrl : settings.speechLegacySynthesisBaseUrl ?? settings.speechServiceBaseUrl, model: purpose === 'asr' ? settings.speechRecognitionModel : settings.speechSynthesisModel, voice: settings.speechVoice, instruction: settings.speechInstruction, key: '' };
}

export function VoiceConnectionSettings({ purpose, settings, onSaved, onOpenVoiceDevices, onOpenChat }: { purpose: Purpose; settings: AppSettings; onSaved: (value: AppSettings) => void; onOpenVoiceDevices: () => void; onOpenChat: () => void }) {
  const voice = window.aiSecretary?.companion;
  const [currentEngine, setCurrentEngine] = useState<Engine | null>(voice?.voiceEngineStatus ? null : 'legacy');
  const [backup, setBackup] = useState(false);
  const engine = currentEngine === null ? null : backup ? currentEngine === 'native' ? 'legacy' : 'native' : currentEngine;
  const [draft, setDraft] = useState<Draft>(() => initial(settings, purpose, 'legacy'));
  const [keyStatus, setKeyStatus] = useState<KeyStatus>('missing');
  const [keyRevision, setKeyRevision] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useWorkbenchDraft(`voice-connection-${purpose}`,dirty,busy);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [lastTested, setLastTested] = useState('');
  const [runtime, setRuntime] = useState<{ enabled: boolean; running: boolean | null; error: string | null } | null>(null);
  const savedDraft = engine ? initial(settings, purpose, engine) : null;
  const savedSignature = savedDraft ? JSON.stringify(savedDraft) : '';

  useEffect(() => {
    let active = true;
    void voice?.voiceEngineStatus?.().then(value => { if (active) setCurrentEngine(value.current); }).catch(() => { if (active) { setCurrentEngine('legacy'); setFailed(true); setMessage('无法读取本机语音处理方式，请到诊断与兼容检查。'); } });
    return () => { active = false; };
  }, [voice]);
  useEffect(() => {
    if (engine && savedDraft && !dirty) { setDraft(savedDraft); setLastTested(''); }
  // A background refresh must not discard an unsaved draft.
  }, [engine, purpose, savedSignature]);
  useEffect(() => {
    if (engine !== 'native') return;
    const key = purpose === 'asr' ? 'recognition' : 'synthesis';
    let active = true;
    void Promise.all([voice?.voiceKeyStatus?.(), voice?.voiceKeyRevisions?.()]).then(([status, revisions]) => {
      if (active) { setKeyStatus(status?.[key] ?? 'unreadable'); setKeyRevision(revisions?.[key] ?? ''); }
    }).catch(() => { if (active) setKeyStatus('unreadable'); });
    return () => { active = false; };
  }, [engine, purpose, voice]);
  useEffect(() => {
    let active = true;
    void voice?.voiceRuntimeStatus?.().then(value => { if (active) setRuntime(value); }).catch(() => { if (active) setRuntime(null); });
    return () => { active = false; };
  }, [voice, engine, purpose]);

  const change = (key: keyof Draft, value: string) => { setDraft(current => ({ ...current, [key]: value })); setDirty(true); setLastTested(''); setMessage(''); setFailed(false); };
  const fingerprint = JSON.stringify([engine, purpose, draft.url.trim(), draft.model.trim(), draft.voice.trim(), draft.instruction.trim(), draft.key.trim(), keyStatus, keyRevision]);
  const keyReady = engine === 'native' ? keyStatus === 'configured' || Boolean(draft.key.trim()) : settings.hasApiKey;
  const complete = Boolean(draft.url.trim() && draft.model.trim() && (purpose === 'asr' || draft.voice.trim()) && keyReady);

  async function save() {
    if (!engine || busy) return;
    setBusy(true); setMessage(''); setFailed(false);
    let parametersSaved = false;
    let credentialSaved = false;
    let rollbackFailed = false;
    let rollbackAttempted = false;
    let patchAttempted = false;
    let previous: Record<string, unknown> | null = null;
    let holdToken: string | null = null;
    try {
      if (engine === 'native') {
        if (!voice?.beginVoiceConnectionSave || !voice.endVoiceConnectionSave) throw new Error('当前客户端无法安全保存实时语音连接。');
        holdToken = await voice.beginVoiceConnectionSave();
      }
      const changes = engine === 'native'
        ? purpose === 'asr' ? { speechServiceBaseUrl: draft.url.trim(), speechRealtimeRecognitionModel: draft.model.trim() } : { speechRealtimeSynthesisBaseUrl: draft.url.trim(), speechRealtimeSynthesisModel: draft.model.trim(), speechRealtimeVoice: draft.voice.trim() }
        : purpose === 'asr' ? { speechLegacyRecognitionBaseUrl: draft.url.trim(), speechRecognitionModel: draft.model.trim() } : { speechLegacySynthesisBaseUrl: draft.url.trim(), speechSynthesisModel: draft.model.trim(), speechVoice: draft.voice.trim(), speechInstruction: draft.instruction.trim() };
      previous = Object.fromEntries(Object.keys(changes).map(key => [key, settings[key as keyof AppSettings]]));
      patchAttempted = true;
      const next = await api.patch<AppSettings>('/settings', changes);
      parametersSaved = true;
      if (engine === 'native' && draft.key.trim()) {
        if (!voice?.saveVoiceKey) throw new Error('当前客户端无法保存本机密钥。');
        try {
          const status = await voice.saveVoiceKey(purpose === 'asr' ? 'recognition' : 'synthesis', draft.key.trim());
          credentialSaved = true;
          setKeyStatus(status[purpose === 'asr' ? 'recognition' : 'synthesis']);
          const revisions = await voice.voiceKeyRevisions?.();
          setKeyRevision(revisions?.[purpose === 'asr' ? 'recognition' : 'synthesis'] ?? '');
        } catch (reason) {
          rollbackAttempted = true;
          try { onSaved(await api.patch<AppSettings>('/settings', previous)); parametersSaved = false; }
          catch { rollbackFailed = true; try { await voice.setVoiceEnabled?.(false); } catch { /* keep the original save failure */ } }
          throw reason;
        }
      }
      if (holdToken) { await voice!.endVoiceConnectionSave!(holdToken); holdToken = null; }
      onSaved(next);
      setDraft(current => ({ ...current, key: '' }));
      setDirty(false);
      setLastTested('');
      void voice?.voiceRuntimeStatus?.().then(setRuntime).catch(() => setRuntime(null));
      setMessage(!keyReady ? '模型参数已保存，但尚缺少可用密钥；此连接不能启动。' : backup ? '备用连接已保存；当前处理方式未切换。' : '连接已保存。新连接将读取新配置；当前语音进程是否已切换，请查看运行状态。');
    } catch (reason) {
      if (patchAttempted && !parametersSaved && !rollbackAttempted && previous) {
        try {
          const latest = await api.get<AppSettings>('/settings');
          const changed = Object.entries(previous).some(([key, value]) => latest[key as keyof AppSettings] !== value);
          onSaved(changed ? await api.patch<AppSettings>('/settings', previous) : latest);
        } catch {
          rollbackFailed = true;
          if (engine === currentEngine) try { await voice?.setVoiceEnabled?.(false); } catch { /* report the uncertain state */ }
        }
      }
      setFailed(true);
      setMessage(`${rollbackFailed ? '保存结果无法核对或回退；已尝试暂停当前语音，请重新打开设置核对连接。' : parametersSaved ? '模型参数已保存，但本机密钥未保存；当前连接不能确认可用，请检查后重试。' : credentialSaved ? '本机密钥已保存，但模型参数未保存；请检查后重试。' : '连接未保存；已核对并保持原模型参数。'}${reason instanceof Error ? reason.message : '请检查连接后重试。'}`);
    } finally {
      if (holdToken) {
        try { await voice?.endVoiceConnectionSave?.(holdToken); }
        catch { setFailed(true); setMessage('语音配置保护状态未能正常结束。请暂停语音并重新打开设置核对连接。'); }
      }
      setBusy(false);
    }
  }

  async function preview() {
    if (purpose === 'asr') { onOpenVoiceDevices(); return; }
    if (!engine || busy || dirty) return;
    setBusy(true); setMessage(''); setFailed(false);
    try {
      if (engine === 'native') {
        if (!await voice?.previewNativeVoice?.()) throw new Error('原生语音未运行，请检查开关、设备和连接。');
      } else {
        const response = await fetch('/api/speech/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '主人，我在，请说。' }), signal: AbortSignal.timeout(20_000) });
        const body = await response.json() as { audioDataUrl?: string; message?: string };
        if (!response.ok || !body.audioDataUrl) throw new Error(body.message || '未生成试听音频。');
        await new Audio(body.audioDataUrl).play();
      }
      setMessage('已触发已保存连接的试听。请确认是否完整听到声音；这不代表当前草稿通过检测。');
    } catch (reason) { setFailed(true); setMessage(reason instanceof Error ? reason.message : '试听失败。'); }
    finally { setBusy(false); }
  }

  async function testDraft() {
    if (!engine || busy || !complete) return;
    setBusy(true); setMessage('正在连接当前草稿…'); setFailed(false); setLastTested('');
    try {
      const result = engine === 'native'
        ? await voice?.testNativeVoiceConnection?.({ purpose: purpose === 'asr' ? 'recognition' : 'synthesis', url: draft.url.trim(), model: draft.model.trim(), voice: draft.voice.trim(), key: draft.key.trim() })
        : await api.post<{ connected: boolean; stage: string; detail: string }>('/speech/connection/test', { purpose, url: draft.url.trim(), model: draft.model.trim(), voice: draft.voice.trim(), instruction: draft.instruction.trim() });
      if (!result?.connected) throw new Error('当前草稿连接未通过，请核对服务地址、模型和凭据。');
      setLastTested(fingerprint);
      setMessage(result.detail);
    } catch (reason) { setFailed(true); setMessage(reason instanceof Error ? reason.message : '草稿连接测试失败。'); }
    finally { setBusy(false); }
  }

  if (!engine) return <p role="status">正在读取当前语音处理方式…</p>;
  const native = engine === 'native';
  return <section className="voice-model-connection" aria-label={purpose === 'asr' ? '语音识别连接' : '语音合成连接'} onKeyDown={event => {
    if (event.key !== 'Enter' || event.target instanceof HTMLButtonElement || !draft.url.trim() || !draft.model.trim() || purpose === 'tts' && !draft.voice.trim()) return;
    event.preventDefault();
    void save();
  }}>
    <div className="settings-group-heading"><h3>{purpose === 'asr' ? '语音识别' : '语音合成'}</h3><p>当前处理方式：{currentEngine === 'native' ? '实时语音 · 本机直连' : '兼容语音 · 由当前服务端执行'}。{backup ? '正在编辑备用连接，保存不会切换处理方式。' : '正在编辑当前处理方式的连接。'}</p><button className="secondary-button" type="button" disabled={busy} onClick={() => { setBackup(value => !value); setMessage(''); setFailed(false); }}>{backup ? '返回当前连接' : '高级：查看另一种语音处理方式'}</button></div>
    <div className="voice-model-states"><span>保存：{dirty ? '草稿未保存' : '已读取保存值'}</span><span>检测：{lastTested === fingerprint ? '此草稿服务连接通过' : '未测试或配置已变化'}</span><span>运行：{backup ? '备用连接 · 当前未使用' : runtime?.error ? `连接异常：${runtime.error}` : runtime?.enabled === false ? '语音已暂停' : runtime?.running === true ? '语音进程运行中；新配置下次连接读取' : runtime?.running === false ? '语音进程未运行' : '运行状态由设备页检查'}</span></div>
    <div className="settings-fields connection-fields">
      <label><span>服务商</span><input disabled value="阿里云百炼" /><small>当前语音链路支持百炼服务。</small></label>
      <label><span>服务地域</span><input disabled value="由服务地址决定" /></label>
      <label className="wide-setting"><span>服务地址</span><input type="url" maxLength={500} value={draft.url} onChange={event => change('url', event.target.value)} placeholder={native ? 'https://dashscope.aliyuncs.com/api/v1' : 'https://业务空间ID.cn-beijing.maas.aliyuncs.com/api/v1'} /></label>
      <label className="wide-setting"><span>{purpose === 'asr' ? '识别模型' : '合成模型'}</span><input maxLength={160} value={draft.model} onChange={event => change('model', event.target.value)} placeholder={native ? purpose === 'asr' ? 'qwen3-asr-flash-realtime' : 'qwen3-tts-flash-realtime' : purpose === 'asr' ? 'qwen-audio-3.0-asr-flash' : 'qwen-audio-3.0-tts-flash'} /></label>
      {purpose === 'tts' ? <><label><span>音色 ID</span><input maxLength={160} value={draft.voice} onChange={event => change('voice', event.target.value)} placeholder={native ? 'Cherry' : 'longanhuan_v3.6'} /></label><label><span>合成表现指令</span><input maxLength={500} disabled={native} value={native ? '' : draft.instruction} onChange={event => change('instruction', event.target.value)} placeholder={native ? '当前实时模型不支持此项' : '自然、清晰的语气'} /><small>{native ? '当前实时模型不支持，使用兼容语音时可设置。' : '仅影响服务生成声音的方式。'}</small></label></> : null}
      {native ? <label className="wide-setting"><span>本机 API Key</span><input type="password" autoComplete="new-password" maxLength={4096} value={draft.key} onChange={event => change('key', event.target.value)} placeholder={keyStatus === 'configured' ? '已加密保存；留空不更换' : '粘贴当前电脑的百炼 API Key'} /><small>{keyStatus === 'configured' ? '已加密保存在当前电脑。' : keyStatus === 'unreadable' ? '旧密钥无法解密，请重新填写。' : '尚未配置。'}识别和合成分别保存，可填写同一份百炼 Key。</small></label> : <div className="wide-setting voice-connection-key"><strong>服务器 API Key</strong><span>{settings.hasApiKey ? '明确复用“对话模型”的密钥，由当前服务端执行。' : '尚未配置对话模型密钥，语音服务无法运行。'}</span><button className="secondary-button" type="button" onClick={onOpenChat}>查看对话模型</button></div>}
    </div>
    {message ? <FeedbackBanner tone={failed ? 'error' : 'info'}>{message}</FeedbackBanner> : null}
    <div className="connection-savebar"><p>测试草稿只验证服务响应；真人转写和听音请到“桌面希微 → 设备与状态”检查。</p><div className="connection-save-actions"><button className="secondary-button" type="button" disabled={busy || !complete} onClick={() => void testDraft()}>测试草稿连接</button><button className="secondary-button" type="button" disabled={busy || dirty || !complete} onClick={() => void preview()}>{purpose === 'asr' ? '检查实际识别' : '试听已保存连接'}</button><button className="primary-button" type="button" disabled={busy || !draft.url.trim() || !draft.model.trim() || purpose === 'tts' && !draft.voice.trim()} onClick={() => void save()}>{busy ? '正在处理…' : backup ? '保存备用连接' : '保存当前连接'}</button></div></div>
  </section>;
}
