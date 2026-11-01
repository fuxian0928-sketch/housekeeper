import {FeedbackBanner} from '../../components/FeedbackBanner';
import {useEffect,useRef,useState} from 'react';
import {Play,Square} from 'lucide-react';
import {api} from '../../api';
import {StyledSelect} from '../../components/ui';
import type {AppSettings} from '../../types';
import {VoiceConnectionSettings as CloudVoiceConnectionSettings} from './VoiceConnectionSettings';
import {SettingsGroup,SettingsHelp,SettingsPaneHeading} from '../settings/SettingsTypography';

type Props={purpose:'asr'|'tts';settings:AppSettings;onSaved:(value:AppSettings)=>void;onOpenVoiceDevices:()=>void;onOpenChat:()=>void};
export function VoiceConnectionSettings(props:Props){
 const {settings,purpose,onSaved,onOpenVoiceDevices}=props,voice=window.aiSecretary?.companion;
 const saved=settings.speechExecution??'cloud';
 const [location,setLocation]=useState(saved),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[failed,setFailed]=useState(false),[restart,setRestart]=useState(false),[playing,setPlaying]=useState(false);
 const audio=useRef<HTMLAudioElement|null>(null);
 useEffect(()=>{setLocation(saved);},[saved]);
 useEffect(()=>()=>{audio.current?.pause();audio.current=null;},[]);
 async function saveLocation(){
  if(busy||location===saved)return;setBusy(true);setMessage('');setFailed(false);let hold:string|null=null,savedPosition=false;
  try{
   hold=await voice?.beginVoiceConnectionSave?.()??null;
   const next=await api.patch<AppSettings>('/settings',{speechExecution:location});savedPosition=true;onSaved(next);
   if(location==='local'&&voice?.voiceEngineStatus){
    const current=await voice.voiceEngineStatus();
    if(current.current!=='native'&&!current.locked){const next=await voice.saveVoiceEngine?.('native');setRestart(Boolean(next?.restartRequired));}
   }
   if(hold){const token=hold;hold=null;await voice!.endVoiceConnectionSave!(token);}
   setMessage(location==='local'?'已保存为本机识别与希微 B 音色。语音模型会在客户端后台准备。':'已保存为云端语音。请检查下方连接与凭据。');
  }catch(reason){setFailed(true);setMessage((savedPosition?'运行位置已保存，客户端准备未完成。':'运行位置未保存。')+(reason instanceof Error?reason.message:'请重试。'));}
  finally{if(hold)try{await voice?.endVoiceConnectionSave?.(hold);}catch{setFailed(true);setMessage('语音连接保护未正常结束，请重新打开客户端后核对运行位置。');}setBusy(false);}
 }
 async function preview(){
  if(playing){audio.current?.pause();setPlaying(false);return;}
  setMessage('');setFailed(false);
  const clip=new Audio(import.meta.env.BASE_URL+'audio/xiwei-soft-local-preview.wav');audio.current?.pause();audio.current=clip;
  clip.onended=()=>setPlaying(false);clip.onerror=()=>{setPlaying(false);setFailed(true);setMessage('样音未能播放，请检查浏览器声音设置后重试。');};
  try{await clip.play();setPlaying(true);}catch{setFailed(true);setMessage('播放未开始，请允许页面播放声音后重试。');}
 }
 return <section className="speech-location-settings" aria-label="语音运行位置">
  <SettingsPaneHeading title={purpose==='asr'?'语音识别':'语音合成'} description={purpose==='asr'?'把录音转换成文字，交给对话模型理解。':'把希微的回答读出来，使用你选定的声音。'}/>
  <SettingsGroup title="语音处理" note="识别与合成共用">
   <div className="speech-location-row wide-setting"><label><span>运行位置</span><StyledSelect value={location} disabled={busy} onChange={event=>setLocation(event.target.value as 'local'|'cloud')}><option value="local">本机（推荐）</option><option value="cloud">云端</option></StyledSelect></label><button type="button" className="secondary-button" disabled={busy||location===saved} onClick={()=>void saveLocation()}>{busy?'正在应用…':'保存运行位置'}</button></div>
  </SettingsGroup>
  {saved==='local'?<div className="local-speech-connection">
   <SettingsGroup title="当前配置" note="本机运行">
   <dl className="local-speech-facts"><div><dt>{purpose==='asr'?'识别引擎':'合成引擎'}</dt><dd>{purpose==='asr'?'Zipformer · 流式中英识别':'MOSS · 本机流式合成'}</dd></div><div><dt>{purpose==='asr'?'运行设备':'固定音色'}</dt><dd>{purpose==='asr'?'当前 Windows 电脑':'希微 B · 软甜温柔'}</dd></div><div><dt>模型资源</dt><dd>由客户端安装包提供</dd></div><div><dt>{purpose==='asr'?'麦克风与断句':'播报方式'}</dt><dd>{purpose==='asr'?'在桌面希微中管理':'自然语速 · 首段生成即可播放'}</dd></div></dl>
   <div className="local-speech-actions wide-setting">{purpose==='tts'?<button type="button" className="secondary-button" onClick={()=>void preview()}>{playing?<Square size={14}/>:<Play size={14}/>} {playing?'停止试听':'试听本机样音'}</button>:null}<button type="button" className="secondary-button" onClick={onOpenVoiceDevices}>查看设备与状态</button></div>
   <div className="wide-setting"><SettingsHelp title="关于本机语音"><p>本机识别与合成不需要语音服务地址或 API Key。对话模型仍单独配置。</p><p>{voice?'首次准备模型需要一些时间；完成后复用已加载的模型。':'网页可以管理配置与查看样音；录音、唤醒和播报在 Windows 客户端运行。'}</p></SettingsHelp></div>
   </SettingsGroup>
  </div>:<CloudVoiceConnectionSettings {...props}/>}
  {restart?<FeedbackBanner tone="warning" action={<button type="button" className="text-button" onClick={()=>void voice?.restartForVoiceEngine?.()}>重启客户端</button>}>本机语音已选定，需要重启客户端一次以启用。</FeedbackBanner>:null}
  {message?<FeedbackBanner tone={failed?'error':'info'}>{message}</FeedbackBanner>:null}
 </section>;
}
