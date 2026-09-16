import { StyledSelect } from './../../components/ui';
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../../api';

export function ChatModelSelect({ value, onChange, defaultModel, baseUrl, disabled }: {
  value: string; onChange: (value: string) => void; defaultModel: string; baseUrl: string; disabled: boolean;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    setModels([]);
    api.post<{ models: string[] }>('/settings/models', {}).then(result => {
      if (active) setModels([...new Set(result.models)]);
    }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [baseUrl, revision]);
  return <div className="chat-model-control">
    <label><span>模型</span><StyledSelect aria-label="对话模型" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">跟随默认 · {defaultModel || '未配置'}</option>
      {value && !models.includes(value) ? <option value={value}>{value}</option> : null}
      {models.map(model => <option key={model} value={model}>{model}</option>)}
    </StyledSelect></label>
    <button type="button" className="model-refresh-button" disabled={loading || disabled} onClick={() => setRevision(x => x + 1)} aria-label={error ? '重试读取模型列表' : '刷新模型列表'} title={loading ? '正在读取模型列表' : error ? '读取失败，点击重试' : '刷新模型列表'}><RefreshCw size={15} className={loading ? 'spin' : undefined} /></button>
  </div>;
}
