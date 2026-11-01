import {FeedbackBanner} from '../../components/FeedbackBanner';
import { useEffect, useState } from 'react';
import type { VoiceLatencyReport } from './types';
const time=(value:number|null)=>value===null?'未记录':`${(value/1000).toFixed(2)} 秒`;
const states={failed:'本轮失败',cancelled:'已取消',submitted:'播放流程完成',finished:'本轮结束',pending:'尚无结束记录'};
export function VoiceLatencySettings(){
  const [report,setReport]=useState<VoiceLatencyReport|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmClear,setConfirmClear]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{let active=true;setBusy(true);const read=window.aiSecretary?.companion.voiceLatency;
    if(!read){setBusy(false);setError('当前客户端不支持语音耗时诊断。');return;}
    void read().then(value=>{if(active)setReport(value)}).catch(()=>{if(active)setError('无法读取语音耗时，请稍后刷新。')}).finally(()=>{if(active)setBusy(false)});return()=>{active=false};
  },[]);
  async function refresh(){setBusy(true);setError('');try{setReport(await window.aiSecretary!.companion.voiceLatency!())}catch{setError('无法读取语音耗时，请稍后刷新。')}finally{setBusy(false)}}
  async function clear(){setBusy(true);setError('');setMessage('');try{setReport(await window.aiSecretary!.companion.clearVoiceLatency!());setConfirmClear(false);setMessage('已清除耗时记录，新对话将重新累计。')}catch{setError('耗时记录未能清除，请检查磁盘空间或文件占用后重试。')}finally{setBusy(false)}}
  async function download(){setBusy(true);setError('');setMessage('');try{const latest=await window.aiSecretary!.companion.voiceLatency!();setReport(latest);const url=URL.createObjectURL(new Blob([JSON.stringify({format:'xiaoe-voice-latency',version:1,audibility:'unverified',...latest},null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='xiaoe-voice-latency.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setMessage('已导出最近10轮耗时，不包含录音、对话文字、项目或密钥。')}catch{setError('耗时报告未能导出，请稍后重试。')}finally{setBusy(false)}}
  return <section className="companion-info-card voice-latency-settings" aria-label="语音耗时诊断">
    <strong>语音耗时诊断</strong>
    <p>查看当前语音引擎最近 10 轮的耗时，不包含录音或对话文字。切换设备或重启引擎后重新累计。</p>
    <button className="secondary-button" type="button" disabled={busy} onClick={()=>void refresh()}>{busy?'正在读取…':'刷新语音耗时'}</button>
    <div className="voice-test-row"><button className="secondary-button" type="button" disabled={busy||!report?.available||!report.turns.length} onClick={()=>void download()}>导出耗时报告</button>{window.aiSecretary?.companion.clearVoiceLatency?<button className="secondary-button" type="button" disabled={busy||!report?.available} onClick={()=>{setConfirmClear(true);setMessage('')}}>清除耗时记录…</button>:null}</div>
    {confirmClear?<div><p>仅清除当前引擎的耗时记录及其本机诊断文件内容。对话、记忆和播放记录保留。</p><div className="voice-test-row"><button className="secondary-button" type="button" disabled={busy} onClick={()=>void clear()}>确认清除耗时</button><button className="secondary-button" type="button" disabled={busy} onClick={()=>setConfirmClear(false)}>取消</button></div></div>:null}
    {message?<FeedbackBanner>{message}</FeedbackBanner>:null}
    {error?<FeedbackBanner tone="error">{error}</FeedbackBanner>:null}
    {report&&!report.available?<p>原生语音引擎尚未就绪，暂无本次运行数据。</p>:report&&report.turns.length===0?<p>尚无语音轮次，完成一次对话后刷新查看。</p>:null}
    {report?.turns.map((row,index)=><details key={`${row.startedAt}:${index}`} open={index===0}><summary>{row.startedAt?new Date(row.startedAt).toLocaleTimeString():'时间未记录'} · {states[row.status]}</summary><dl>
      <div><dt>录音结束至首段音频生成</dt><dd>{time(row.responseWaitMs)}</dd></div>
      <div><dt>录音结束至识别完成</dt><dd>{time(row.asrWaitMs)}</dd></div>
      <div><dt>回答开始至首字返回</dt><dd>{time(row.answerFirstMs)}</dd></div>
      <div><dt>语音合成连接准备</dt><dd>{time(row.ttsConnectMs)}</dd></div>
      <div><dt>首句送出至首段音频生成</dt><dd>{time(row.ttsFirstMs)}</dd></div>
    </dl></details>)}
    <p>部分阶段并行，不能直接相加。“播放流程完成”不代表已验证音箱实际出声；未记录也不代表耗时为零。</p>
  </section>;
}
