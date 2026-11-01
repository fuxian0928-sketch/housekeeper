import {FeedbackBanner} from '../../components/FeedbackBanner';
import { useEffect, useRef, useState } from 'react';
import { StyledSelect } from '../../components/ui';
import type { NativeVoiceDevices } from './types';
import { voiceDeviceErrorMessage } from './voice-device-error';

export function NativeVoiceDeviceSettings() {
  const [devices,setDevices]=useState<NativeVoiceDevices|null>(null);
  const [selected,setSelected]=useState({inputName:'',outputName:''});
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [testing,setTesting]=useState(false);
  const [level,setLevel]=useState(0);
  const stream=useRef<MediaStream|null>(null);
  const context=useRef<AudioContext|null>(null);
  const frame=useRef<number|null>(null);
  const inputRequest=useRef(0);
  const stopInput=()=>{
    inputRequest.current++;
    if(frame.current!==null)cancelAnimationFrame(frame.current);
    frame.current=null;stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;
    void context.current?.close();context.current=null;setTesting(false);setLevel(0);
  };
  useEffect(()=>()=>stopInput(),[]);
  useEffect(()=>{let active=true;const api=window.aiSecretary?.companion;
    if(!api?.listNativeDevices){setError('当前客户端尚不支持原生设备配置。');return;}
    setBusy(true);void api.listNativeDevices().then(value=>{if(active){setDevices(value);setSelected(value.selected);}}).catch(error=>{if(active)setError(voiceDeviceErrorMessage(error));}).finally(()=>{if(active)setBusy(false);});
    return()=>{active=false;};
  },[]);
  async function refresh(){
    setBusy(true);setError('');setMessage('');
    try{const value=await window.aiSecretary!.companion.listNativeDevices!();setDevices(value);if(!devices)setSelected(value.selected);}catch(error){setDevices(null);setError(voiceDeviceErrorMessage(error));}finally{setBusy(false);}
  }
  async function save(){
    stopInput();
    setBusy(true);setError('');setMessage('');
    try{const result=await window.aiSecretary!.companion.saveNativeDevices!(selected);
      if(!result.saved)throw Error();
      setDevices(current=>current?{...current,selected}:current);
      if(result.applied)setMessage('已保存并重新连接，请重新唤醒希微。');
      else setError(result.error||'设备已保存，但语音尚未连接。请查看上方的语音连接状态。');
    }catch(error){setError(voiceDeviceErrorMessage(error));}finally{setBusy(false);}
  }
  async function testInput(){
    stopInput();setError('');setMessage('');
    const request=inputRequest.current;
    try{
      const rows=await navigator.mediaDevices.enumerateDevices();
      if(request!==inputRequest.current)return;
      const device=rows.find(row=>row.kind==='audioinput'&&(selected.inputName==='__system_default__'?row.deviceId==='default':row.label===selected.inputName));
      if(!device&&selected.inputName!=='__system_default__')throw Error('浏览器未找到与所选原生麦克风同名的输入设备；请检查系统权限，或通过手动语音实际试用。');
      const capture=await navigator.mediaDevices.getUserMedia({audio:selected.inputName==='__system_default__'?true:{deviceId:{exact:device!.deviceId}},video:false});
      if(request!==inputRequest.current){capture.getTracks().forEach(track=>track.stop());return;}
      stream.current=capture;const audio=new AudioContext();context.current=audio;
      const analyser=audio.createAnalyser();analyser.fftSize=512;audio.createMediaStreamSource(capture).connect(analyser);
      const samples=new Uint8Array(analyser.fftSize);
      const update=()=>{analyser.getByteTimeDomainData(samples);let power=0;for(const value of samples)power+=((value-128)/128)**2;setLevel(Math.min(100,Math.round(Math.sqrt(power/samples.length)*260)));frame.current=requestAnimationFrame(update)};
      setTesting(true);setMessage('正在检测所选麦克风；请说一句话观察音量变化。停止后立即释放设备。');update();
    }catch(reason){if(request!==inputRequest.current)return;stopInput();setError(reason instanceof Error?reason.message:'麦克风检测失败。');}
  }
  async function testOutput(){
    setError('');setMessage('');
    try{if(!await window.aiSecretary?.companion.previewNativeVoice?.())throw Error('当前原生语音未运行，暂时无法试听。');setMessage('已发起已保存音色的试听；请确认所选音箱是否实际出声。');}
    catch(reason){setError(reason instanceof Error?reason.message:'音箱试听失败。');}
  }
  const valid=devices?.inputs.some(d=>d.name===selected.inputName&&d.available)&&devices?.outputs.some(d=>d.name===selected.outputName&&d.available);
  const outputSaved=selected.outputName===devices?.selected.outputName;
  return <section className="companion-info-card native-voice-device-settings" aria-label="原生语音设备">
    <strong>语音设备</strong>
    <p>默认跟随 Windows 的麦克风与扬声器，启动时自动连接。</p>
    {(['inputName','outputName'] as const).map(key=>{const rows=key==='inputName'?devices?.inputs:devices?.outputs;const title=key==='inputName'?'麦克风':'扬声器';return <label className="companion-credential-field" key={key}><span><strong>{title}</strong></span><StyledSelect aria-label={title} disabled={busy||!devices} value={selected[key]} onChange={event=>{setSelected({...selected,[key]:event.target.value});setMessage('');}}><option value="">正在读取设备</option>{selected[key]&&!rows?.some(d=>d.name===selected[key])?<option value={selected[key]} disabled>{selected[key]}（未找到）</option>:null}{rows?.map(d=><option key={d.name} value={d.name} disabled={!d.available}>{d.name==='__system_default__'?`系统默认${title}`:d.name}{d.available?'':'（不可用）'}</option>)}</StyledSelect></label>})}
    <div className="companion-setting-actions"><button className="secondary-button" type="button" disabled={busy} onClick={()=>void refresh()}>刷新音频设备</button><button className="primary-button" type="button" disabled={busy||!valid} onClick={()=>void save()}>{busy?'正在处理…':'保存并重新连接'}</button></div>
    <div className="companion-setting-actions"><button className="secondary-button" type="button" disabled={busy||!selected.inputName} onClick={()=>testing?stopInput():void testInput()}>{testing?'停止麦克风检测':'检测所选麦克风'}</button><button className="secondary-button" type="button" disabled={busy||!selected.outputName||!outputSaved} onClick={()=>void testOutput()}>试听已保存音箱</button><span>{testing?`输入音量 ${level}%`:'检测和试听仅在点击后打开设备。'}</span></div>
    <p>刷新只读取设备列表，不打开麦克风。未连接或重名的设备不可选。切换页面会停止输入检测。</p>
    {error?<FeedbackBanner tone="error">{error}</FeedbackBanner>:null}{message?<FeedbackBanner>{message}</FeedbackBanner>:null}
  </section>;
}
