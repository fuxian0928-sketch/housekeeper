import {FeedbackBanner} from '../../components/FeedbackBanner';
import {useEffect,useState} from 'react';
import type {ComputerStatus} from './interaction-types';
import {SettingsPaneHeading} from '../settings/SettingsTypography';

export function ComputerConnectionSettings(){
  const computer=window.aiSecretary?.computer;
  const [status,setStatus]=useState<ComputerStatus>({connected:false}),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(!computer)return;let active=true;const update=()=>void computer.status().then(value=>{if(active)setStatus(value);}).catch(()=>{if(active)setError('暂时无法读取本机连接状态。');});update();const timer=setInterval(update,3000);return()=>{active=false;clearInterval(timer);};},[computer]);
  async function toggle(){if(!computer||busy)return;setBusy(true);setError('');try{setStatus(await(status.connected||status.connecting?computer.disconnect():computer.connect()));}catch(reason){setError(reason instanceof Error?reason.message:'连接未完成，请检查 Windows MCP 环境。');}finally{setBusy(false);}}
  return <section className="settings-form subpage-panel computer-settings"><SettingsPaneHeading title="电脑控制" description="连接当前 Windows 电脑，让希微查看界面并完成操作。"/><div className="settings-state-row"><div><strong>本机连接</strong><p role="status">{!computer?'请在 Windows 客户端连接当前电脑。':status.awaitingReceipt?'操作结果正在确认，请稍候。':status.connecting?'正在恢复本机连接…':status.connected?'已连接 · 下次启动自动恢复':'本机控制未连接'}</p></div><button className="secondary-button" type="button" disabled={busy||!computer} onClick={()=>void toggle()}>{busy?'正在处理…':status.connecting?'取消连接':status.connected?'断开本机':'连接本机'}</button></div>{error||status.error?<FeedbackBanner tone="error">{error||status.error}</FeedbackBanner>:null}</section>;
}
