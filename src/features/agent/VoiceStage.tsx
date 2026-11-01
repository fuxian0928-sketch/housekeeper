import {FeedbackBanner} from '../../components/FeedbackBanner';
import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {AudioLines,ScanFace,Sun,UserRound,Moon} from 'lucide-react';
import {createPortal} from 'react-dom';
import {MatrixOrb,type MatrixOrbState} from './MatrixOrb';
import type {CompanionConfig,CompanionState} from '../companion/types';
import {readScenePreferences,saveScenePreferences,subscribeScenePreferences} from './scene-preferences';
import './orbital-stage.css';
const PortraitStage=lazy(()=>import('./PortraitStage').then(module=>({default:module.PortraitStage})));

const states:Record<CompanionState,{label:string;tone:string;hint:string}>={idle:{label:'等待唤醒',tone:'idle',hint:'叫“希微”开始，或点击唤醒。'},waking:{label:'正在唤醒',tone:'listening',hint:'希微正在接入语音。'},listening:{label:'正在聆听',tone:'listening',hint:'请说出你想处理的事情。'},thinking:{label:'正在处理',tone:'processing',hint:'有新进展会同步到执行记录。'},speaking:{label:'正在回应',tone:'speaking',hint:'可按你的打断设置继续说话。'},notifying:{label:'正在提醒',tone:'speaking',hint:'希微有一条提醒。'},camera:{label:'正在查看画面',tone:'processing',hint:'仅在已启用的摄像头范围内查看。'}};
const orbStates:Record<CompanionState,MatrixOrbState>={idle:'idle',waking:'listening',listening:'listening',thinking:'thinking',speaking:'speaking',notifying:'speaking',camera:'thinking'};
export function VoiceStage(){
  const preview=import.meta.env.DEV&&import.meta.env.VITE_INTERFACE_PREVIEW==='1';
  const [state,setState]=useState<CompanionState>('idle'),[error,setError]=useState(''),[runtimeError,setRuntimeError]=useState(''),[busy,setBusy]=useState(false);
  const [feedbackTarget,setFeedbackTarget]=useState<HTMLElement|null>(null);
  const [dismissedRuntimeError,setDismissedRuntimeError]=useState('');
  const pendingControl=useRef(false);
  const level=useRef({value:0,at:0});
  const [scene,setScene]=useState(readScenePreferences),[zoom,setZoom]=useState(false);
  const [portraitLoaded,setPortraitLoaded]=useState(scene.view==='portrait');
  const companion=window.aiSecretary?.companion,current=states[state];
  const awake=state!=='idle';
  const feedback=error||(runtimeError!==dismissedRuntimeError?runtimeError:'');
  useEffect(()=>{setFeedbackTarget(document.getElementById('workbench-feedback'));},[]);
  useEffect(()=>subscribeScenePreferences(setScene),[]);
  useEffect(()=>{if(scene.view==='portrait')setPortraitLoaded(true);},[scene.view]);
  useEffect(()=>companion?.onPlaybackLevel?.(value=>{if(Number.isFinite(value))level.current={value:Math.max(0,Math.min(1,value)),at:performance.now()};}),[companion]);
  useEffect(()=>{
    if(!companion)return;
    let live=true,received=false;
    const off=companion.onStateChanged(value=>{received=true;if(live){setState(value);setError('');}});
    void companion.getState().then(value=>{if(live&&!received)setState(value);}).catch(()=>{if(live&&!received)setError('语音状态暂时无法读取，请在设备与状态中检查。');});
    return()=>{live=false;off();};
  },[companion]);
  useEffect(()=>{
    if(!companion)return;
    let live=true,received=false;
    const update=(config:CompanionConfig)=>{if(live)setRuntimeError(config.nativeVoiceError||'');};
    const off=companion.onConfigChanged(config=>{received=true;update(config);});
    void companion.getConfig().then(config=>{if(!received)update(config);}).catch(()=>{});
    return()=>{live=false;off();};
  },[companion]);
  useEffect(()=>{setDismissedRuntimeError('');},[runtimeError]);
  async function control(action:'wake'|'dismiss'){
    if(pendingControl.current)return;
    pendingControl.current=true;setBusy(true);setError('');setDismissedRuntimeError('');
    try{
      if(!companion?.nativeControl)throw new Error('请在桌面客户端的语音设置中开启语音。');
      if(!await companion.nativeControl(action))throw new Error('语音尚未就绪，请在设备与状态中检查连接。');
    }catch(reason){setError(reason instanceof Error?reason.message:'语音操作未完成。');}
    finally{pendingControl.current=false;setBusy(false);}
  }
  return <section className="workbench-voice orbital-stage" data-tone={current.tone} data-view={scene.view} data-state={state} aria-label="希微人物与语音">
    {portraitLoaded?<Suspense fallback={<div className="portrait-loading" role="status">正在准备希微…</div>}><PortraitStage state={state} visible={scene.view==='portrait'} motion={scene.motion} light={scene.light} zoom={zoom} level={level}/></Suspense>:null}
    <div className="stage-view-controls" aria-label="场景外观">
      {scene.view==='portrait'?<><button type="button" aria-label={zoom?'查看完整场景':'靠近希微'} aria-pressed={zoom} onClick={()=>setZoom(value=>!value)}><ScanFace size={16}/></button><button type="button" aria-label={scene.light?'调暗舱室灯光':'点亮舱室灯光'} aria-pressed={scene.light} onClick={()=>setScene(saveScenePreferences({light:!scene.light}))}><Sun size={16}/></button></>:null}
      <button type="button" aria-label={scene.view==='portrait'?'切换为圆形语音':'切换为人物场景'} onClick={()=>setScene(saveScenePreferences({view:scene.view==='portrait'?'voice':'portrait'}))}>{scene.view==='portrait'?<AudioLines size={16}/>:<UserRound size={16}/>}</button>
    </div>
    <div className="orbital-voice-view" aria-hidden={scene.view!=='voice'} inert={scene.view!=='voice'}><div className="voice-stage-visual"><span className="voice-stage-aura" aria-hidden="true"/><span className="voice-stage-lens" aria-hidden="true"/><span className="voice-stage-orbit orbit-outer" aria-hidden="true"/><span className="voice-stage-orbit orbit-inner" aria-hidden="true"/><MatrixOrb state={orbStates[state]} size={262} dots={13}/></div></div>
    <strong role="status" className={preview?undefined:'sr-only'}>{companion||preview?current.label:'语音需在桌面客户端使用'}</strong>
    {feedback&&feedbackTarget?createPortal(<FeedbackBanner tone="error" onDismiss={()=>{setError('');setDismissedRuntimeError(runtimeError);}}>{feedback}</FeedbackBanner>,feedbackTarget):null}
    {!feedback&&preview?<p>{!companion?'交互预览 · 示例资料，动效演示不会录音。':current.hint}</p>:null}
    {companion||preview?<div className="voice-stage-actions"><button type="button" className="secondary-button" disabled={busy} aria-busy={busy} onClick={()=>preview&&!companion?setState(awake?'idle':'listening'):void control(awake?'dismiss':'wake')}>{awake?<Moon size={14}/>:null}{awake?'退下':'唤醒希微'}</button></div>:null}
  </section>;
}
