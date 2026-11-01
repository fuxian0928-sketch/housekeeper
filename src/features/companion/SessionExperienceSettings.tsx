import {FeedbackBanner} from '../../components/FeedbackBanner';
import { useEffect, useState } from 'react';
import { api } from '../../api';

type Snapshot={enabled:boolean;records:Array<{quote:string;observedAt:string;sourceMessageId:string;conversationId:string}>};
export function SessionExperienceSettings(){
  const [value,setValue]=useState<Snapshot|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  useEffect(()=>{let active=true;void api.get<Snapshot>('/voice/session-experiences').then(data=>{if(active)setValue(data);}).catch(()=>{if(active)setError('会话感受记忆暂时无法读取，请刷新重试。');});return()=>{active=false;};},[]);
  async function perform(action:'refresh'|'toggle'|'clear'){
    setBusy(true);setError('');setMessage('');
    try{
      const next=action==='refresh'?await api.get<Snapshot>('/voice/session-experiences'):action==='clear'?await api.delete<Snapshot>('/voice/session-experiences'):await api.patch<Snapshot>('/voice/session-experiences',{enabled:!value?.enabled});
      setValue(next);setMessage(action==='clear'?'本次运行中的感受记录已清空。':action==='toggle'?(next.enabled?'已开启，从后续语音对话开始记录。':'已关闭并清空，后台提取已取消。'):'已刷新。');
    }catch{setError('操作未完成，请稍后重试。');}finally{setBusy(false);}
  }
  async function remove(row:Snapshot['records'][number]){
    setBusy(true);setError('');setMessage('');
    try{setValue(await api.delete<Snapshot>(`/voice/session-experiences/${encodeURIComponent(row.conversationId)}/${encodeURIComponent(row.sourceMessageId)}`));setMessage('这条感受记录已移除，原始聊天保留。')}catch{setError('记录未能移除，请刷新后重试。')}finally{setBusy(false);}
  }
  return <section className="companion-info-card session-experience-settings" aria-label="会话感受记忆">
    <strong>会话感受记忆</strong>
    <p>记住语音中你明确表达的感受，帮助希微理解后续聊天。仅在本次运行的对应会话中使用，30 分钟后失效；提取可能产生少量模型调用费用。</p>
    <p>关闭或清空会立即丢弃这些记录，不删除原始聊天历史或长期记忆。</p>
    <div className="companion-setting-actions">
      <button className="secondary-button" type="button" disabled={busy||!value} aria-pressed={value?.enabled??false} onClick={()=>void perform('toggle')}>{value?.enabled?'关闭会话感受记忆':'开启会话感受记忆'}</button>
      <button className="secondary-button" type="button" disabled={busy} onClick={()=>void perform('refresh')}>刷新感受记录</button>
      <button className="secondary-button" type="button" disabled={busy||!value} onClick={()=>void perform('clear')}>清空感受记录</button>
    </div>
    {error?<FeedbackBanner tone="error">{error}</FeedbackBanner>:null}{message?<FeedbackBanner>{message}</FeedbackBanner>:null}
    {value?.records.length?<ul>{value.records.map(row=><li key={`${row.conversationId}:${row.sourceMessageId}:${row.quote}`}><q>{row.quote}</q><small> · {new Date(row.observedAt).toLocaleString()}</small><button className="secondary-button" type="button" disabled={busy} onClick={()=>void remove(row)}>移除这条记录</button><details><summary>查看来源标识</summary><p>对话：{row.conversationId}<br/>消息：{row.sourceMessageId}</p></details></li>)}</ul>:<p>{value?'当前没有有效的感受记录。':'正在读取…'}</p>}
  </section>;
}
