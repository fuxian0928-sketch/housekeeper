import {FeedbackBanner} from '../../components/FeedbackBanner';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { StyledSelect } from '../../components/ui';

type Expression = { version: 1; address: string; length: 'brief' | 'balanced' | 'detailed'; prompt: string };
export function VoiceExpressionSettings() {
  const [value, setValue] = useState<Expression | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void api.get<Expression>('/voice/expression').then(result => { if (active) setValue(result); }).catch(() => { if (active) setError('表达设置读取失败，请重新进入此页面。'); });
    return () => { active = false; };
  }, []);
  function change(patch: Partial<Expression>) { if (value) setValue({ ...value, ...patch }); setMessage('有未保存的表达设置，请在切换页面前保存。'); }
  async function save() {
    if (!value) return;
    setBusy(true); setError(''); setMessage('');
    try { setValue(await api.put<Expression>('/voice/expression', value)); setMessage('已保存，下一轮生活语音生效。'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试。'); }
    finally { setBusy(false); }
  }
  return <section className="companion-info-card voice-expression-settings" aria-label="生活语音表达">
    <strong>生活语音表达</strong>
    <p>保存到当前服务，连接此服务的设备共用。只调整生活语音回答，不改变工作流程、唤醒回应或音色。</p>
    {value ? <fieldset disabled={busy}>
      <label><span>怎么称呼你</span><input value={value.address} maxLength={20} onChange={event => change({ address: event.target.value })} /></label>
      <label><span>回答长度</span><StyledSelect value={value.length} onChange={event => change({ length: event.target.value as Expression['length'] })}><option value="brief">简短 · 10–80 字</option><option value="balanced">适中 · 80–160 字</option><option value="detailed">展开 · 160–300 字</option></StyledSelect></label>
      <label><span>聊天提示词（可选）</span><textarea rows={4} maxLength={2000} placeholder="例如：语气干练温柔，少用语气词，先回答我的问题。" value={value.prompt} onChange={event => change({ prompt: event.target.value })} /></label>
      <small>留空使用原有聊天风格。字数是表达目标，不会截断回答；身份和事实规则始终保留。</small>
      <div className="companion-setting-actions"><button type="button" className="primary-button" onClick={() => void save()} disabled={!value.address.trim()}>{busy ? '保存中…' : '保存表达设置'}</button><button type="button" className="secondary-button" onClick={() => change({ address: '主人', length: 'brief', prompt: '' })}>恢复默认草稿</button></div>
    </fieldset> : !error ? <p>正在读取…</p> : null}
    {error ? <FeedbackBanner tone="error">{error}</FeedbackBanner> : null}{message ? <FeedbackBanner>{message}</FeedbackBanner> : null}
  </section>;
}
