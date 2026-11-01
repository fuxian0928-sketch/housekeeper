import { useEffect, useState } from 'react';
import { StyledSelect } from '../../components/ui';
type Status={current:'native'|'legacy';requested:'native'|'legacy';available:boolean;locked:boolean;restartRequired:boolean};
function voiceEngineErrorMessage(error: unknown) {
  const reason = error instanceof Error ? error.message : '';
  if (reason.includes('原生语音资源校验失败') || reason.includes('VOICE_NATIVE_BUNDLE_INVALID')) return '原生语音资源校验失败，请修复或重装客户端。';
  if (reason.includes('缺少原生语音资源') || reason.includes('VOICE_NATIVE_BUNDLE_MISSING')) return '当前安装缺少原生语音资源，请修复或重装客户端。';
  if (reason.includes('选择不可修改') || reason.includes('VOICE_ENGINE_SELECTION_INVALID')) return '当前语音引擎选择不可修改。';
  if (reason.includes('应用数据目录')) return '语音引擎选择未保存，请检查本机应用数据目录是否可写。';
  return '语音引擎选择未保存，请重试。';
}
export function VoiceEngineSettings() {
  const [status,setStatus]=useState<Status|null>(null);
  const [choice,setChoice]=useState<'native'|'legacy'>('legacy');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [failed,setFailed]=useState(false);
  const api=window.aiSecretary?.companion;
  useEffect(()=>{let active=true;void api?.voiceEngineStatus?.().then(value=>{if(active){setStatus(value);setChoice(value.requested)}}).catch(()=>{if(active){setFailed(true);setMessage('无法读取语音引擎设置，请重试。')}});return()=>{active=false}},[api]);
  if(!api?.voiceEngineStatus)return null;
  async function save(){setBusy(true);setFailed(false);setMessage('正在检查资源并保存…');try{const value=await api!.saveVoiceEngine!(choice);setStatus(value);setMessage(value.restartRequired?'已保存。请点击“立即重启客户端”切换语音处理方式。':'已保存，当前已使用所选处理方式。')}catch(error){setFailed(true);setMessage(voiceEngineErrorMessage(error))}finally{setBusy(false)}}
  async function restart(){setBusy(true);setFailed(false);try{if(!await api?.restartForVoiceEngine?.())throw new Error('重启未启动，请从托盘菜单选择“退出”，然后重新打开客户端。');setMessage('正在重启客户端…')}catch(error){setFailed(true);setMessage(error instanceof Error?error.message:'重启失败，请从托盘菜单退出后重新打开客户端。');setBusy(false)}}
  return <section className="companion-info-card voice-engine-settings" aria-label="语音处理方式">
    <strong>语音处理方式</strong>
    <span>当前使用：{status?status.current==='native'?'实时语音':'兼容语音':'读取中…'}。关闭窗口只会缩到托盘；切换处理方式需要重启客户端。</span>
    {status?<>
      <label className="voice-engine-choice"><span><strong>下次启动使用</strong><small>{status.locked?'当前由开发启动配置指定。':status.available?'实时语音使用本机唤醒和独立音频进程，仍需配置设备与语音服务。':'当前安装中尚无完整的实时语音资源包。'}</small></span><StyledSelect aria-label="下次启动使用" value={status.locked?status.current:choice} disabled={busy||status.locked} onChange={event=>setChoice(event.target.value as 'native'|'legacy')}><option value="legacy">兼容语音</option><option value="native" disabled={!status.available}>实时语音</option></StyledSelect></label>
      <button type="button" className="secondary-button" disabled={busy||status.locked||!api.saveVoiceEngine} onClick={()=>void save()}>{busy?'正在保存…':'保存引擎选择'}</button>
      {status.restartRequired?<><span>{status.requested==='native'&&!status.available?'实时语音资源不可用，请修复安装后再重启。':`待重启：下次使用${status.requested==='native'?'实时语音':'兼容语音'}。`}</span><button type="button" className="primary-button" disabled={busy||!api.restartForVoiceEngine||status.requested==='native'&&!status.available} onClick={()=>void restart()}>立即重启客户端</button></>:null}
      {status.available&&status.current!=='native'?<span>麦克风与扬声器请在“设备与状态”选择；模型与凭据在“模型连接”配置。</span>:null}
    </>:null}
    <span role={failed?'alert':'status'}>{message}</span>
  </section>;
}
