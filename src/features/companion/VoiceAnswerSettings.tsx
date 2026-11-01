import {FeedbackBanner} from '../../components/FeedbackBanner';
import { useEffect, useState } from 'react';
import { StyledSelect } from '../../components/ui';
import type { AppSettings } from '../../types';
import type { CompanionConfig } from './types';
import {ChevronDown} from 'lucide-react';

type Effort = NonNullable<CompanionConfig['voiceReasoningEffort']>;

export function VoiceAnswerSettings({ settings, availableModels }: { settings: AppSettings; availableModels: string[] }) {
  const [config, setConfig] = useState<CompanionConfig | null>(null);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<Effort>('follow');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const api = window.aiSecretary?.companion;

  useEffect(() => {
    let active = true;
    if (!api) return;
    void api.getConfig().then(value => {
      if (!active) return;
      setConfig(value);
      setModel(value.voiceChatModel || '');
      setEffort(value.voiceReasoningEffort || 'follow');
    }).catch(reason => { if (active) { setFailed(true); setMessage(reason instanceof Error ? reason.message : '语音回答设置读取失败。'); } });
    return () => { active = false; };
  }, [api]);

  async function save() {
    if (!api || !config || busy) return;
    setBusy(true); setFailed(false); setMessage('');
    try {
      const next = await api.updateConfig({ voiceChatModel: model.trim(), voiceReasoningEffort: effort });
      setConfig(next);
      setMessage('已保存。实时和兼容语音都会从下一轮回答开始使用这项选择。');
    } catch (reason) { setFailed(true); setMessage(reason instanceof Error ? reason.message : '语音回答模型保存失败。'); }
    finally { setBusy(false); }
  }

  return <details className="voice-answer-disclosure"><summary>语音单独设置<small>{model||effort!=='follow'?'此设备已单独指定':'默认跟随对话'}</small><ChevronDown aria-hidden="true"/></summary><section className="voice-answer-settings" aria-label="语音回答模型" onKeyDown={event => {
    if (event.key !== 'Enter' || event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    void save();
  }}>
    <div className="settings-group-heading"><h3>此设备的语音回答</h3><p>需要语音使用不同模型或默认深度时，再单独指定。</p></div>
    {!api ? <p>请在 Windows 客户端中配置语音回答模型。</p> : !config ? <p>{failed ? '暂时无法读取本机设置。' : '正在读取本机设置…'}</p> : <div className="settings-fields connection-fields">
      <label><span>回答模型</span><StyledSelect value={model ? 'custom' : 'follow'} onChange={event => { setModel(event.target.value === 'follow' ? '' : availableModels.find(item => item !== settings.model) || settings.model); setMessage(''); }}><option value="follow">跟随默认 · {settings.model}</option><option value="custom">单独指定</option></StyledSelect><small>使用当前对话服务的地址与密钥。</small></label>
      <label><span>默认思考深度</span><StyledSelect value={effort} onChange={event => { setEffort(event.target.value as Effort); setMessage(''); }}><option value="follow">跟随对话默认</option><option value="auto">自动 · 按任务判断</option><option value="low">快速 · 优先响应</option><option value="medium">标准 · 日常分析</option><option value="high">深入 · 复杂问题</option></StyledSelect><small>每次说“认真想一下”或“简单说”可覆盖本次任务，不修改这里的默认值。</small></label>
      {model ? <label className="wide-setting"><span>语音回答模型 ID</span><input maxLength={160} value={model} onChange={event => { setModel(event.target.value); setMessage(''); }} list="voice-answer-models" placeholder="输入当前对话服务支持的模型 ID" /><datalist id="voice-answer-models">{availableModels.map(item => <option key={item} value={item} />)}</datalist><small>使用与默认对话模型相同的服务地址和凭据。</small></label> : null}
      <div className="wide-setting connection-save-actions"><span>范围：当前电脑；下一轮语音回答生效。</span><button className="secondary-button" type="button" disabled={busy || !!model && !model.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存语音回答选择'}</button></div>
    </div>}
    {message ? <FeedbackBanner tone={failed ? 'error' : 'info'}>{message}</FeedbackBanner> : null}
  </section></details>;
}
