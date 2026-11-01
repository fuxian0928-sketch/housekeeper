import {FeedbackBanner} from '../../components/FeedbackBanner';
import {useEffect,useRef,useState} from 'react';
import {MessageSquare,Eye,Mic,Volume2,Search,KeyRound,Download,RefreshCw,LoaderCircle} from 'lucide-react';
import {api} from '../../api';
import {StyledSelect} from '../../components/ui';
import type {AppSettings} from '../../types';
import {version as CLIENT_VERSION} from '../../../package.json';
import {useWorkbenchDraft} from '../conversations/useWorkbenchTabs';
import {CompanionSettings} from '../companion/CompanionSettings';
import {VoiceConnectionSettings} from '../companion/SpeechLocationSettings';
import {VoiceAnswerSettings} from '../companion/VoiceAnswerSettings';
import {isNewerClientVersion,type ClientRelease} from './client-release';
import './settings.css';
import {SettingsGroup,SettingsHelp,SettingsPaneHeading} from './SettingsTypography';
import './settings-typography.css';

const settingsSections=[{id:'model',title:'模型与回答',icon:MessageSquare},{id:'companion',title:'桌面与语音',icon:Volume2},{id:'update',title:'关于与更新',icon:Download}] as const;

export function SettingsWorkspace({ settings, onSaved, onError }: { settings: AppSettings | null; onSaved: (settings: AppSettings) => void; onError: (message: string) => void }) {
  const [connectionTab, setConnectionTab] = useState<'chat' | 'vision' | 'asr' | 'tts' | 'retrieval'>('chat');
  const [openCompanionDevices, setOpenCompanionDevices] = useState(false);
  const connectionDetailRef = useRef<HTMLDivElement | null>(null);
  const previousSettings = useRef(settings);
  const [section, setSection] = useState<'model' | 'companion' | 'update'>('model');
  const [model, setModel] = useState(settings?.model ?? '');
  const [visionModel, setVisionModel] = useState(settings?.visionModel ?? 'qwen3-vl-flash');
  const [visionApiBaseUrl,setVisionApiBaseUrl]=useState(settings?.visionApiBaseUrl??'');
  const [visionApiKey,setVisionApiKey]=useState('');
  const [embeddingModel, setEmbeddingModel] = useState(settings?.embeddingModel ?? 'BAAI/bge-m3');
  const [rerankerModel, setRerankerModel] = useState(settings?.rerankerModel ?? 'BAAI/bge-reranker-v2-m3');
  const [apiBaseUrl, setApiBaseUrl] = useState(settings?.apiBaseUrl ?? '');
  const [retrievalApiBaseUrl, setRetrievalApiBaseUrl] = useState(settings?.retrievalApiBaseUrl ?? '');
  const [reasoningEffort, setReasoningEffort] = useState<AppSettings['reasoningEffort']>(settings?.reasoningEffort ?? 'auto');
  const [webSearchPolicy, setWebSearchPolicy] = useState<AppSettings['webSearchPolicy']>(settings?.webSearchPolicy ?? 'ask');
  const [voiceWebSearchEnabled,setVoiceWebSearchEnabled]=useState(settings?.voiceWebSearchEnabled??false);
  const [aiEnabled, setAiEnabled] = useState(settings?.aiEnabled ?? false);
  const [apiKey, setApiKey] = useState('');
  const [retrievalApiKey, setRetrievalApiKey] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testFailed, setTestFailed] = useState(false);
  const [release, setRelease] = useState<ClientRelease | null>(null);
  const [releaseAction, setReleaseAction] = useState<'idle' | 'checking' | 'downloading'>('idle');
  const [releaseMessage, setReleaseMessage] = useState<string | null>(null);
  useWorkbenchDraft('settings', Boolean(settings && (model !== settings.model || visionModel !== settings.visionModel || visionApiBaseUrl !== (settings.visionApiBaseUrl??'') || embeddingModel !== settings.embeddingModel || rerankerModel !== settings.rerankerModel || apiBaseUrl !== settings.apiBaseUrl || retrievalApiBaseUrl !== settings.retrievalApiBaseUrl || reasoningEffort !== settings.reasoningEffort || webSearchPolicy !== settings.webSearchPolicy || voiceWebSearchEnabled !== (settings.voiceWebSearchEnabled??false) || aiEnabled !== settings.aiEnabled) || apiKey || visionApiKey || retrievalApiKey), busy || modelBusy);

  useEffect(() => {
    if (!settings) return;
    const previous = previousSettings.current;
    setModel(current => current === previous?.model ? settings.model : current);
    setVisionModel(current => current === previous?.visionModel ? settings.visionModel : current);
    setVisionApiBaseUrl(current=>current===(previous?.visionApiBaseUrl??'')?(settings.visionApiBaseUrl??''):current);
    setEmbeddingModel(current => current === previous?.embeddingModel ? settings.embeddingModel : current);
    setRerankerModel(current => current === previous?.rerankerModel ? settings.rerankerModel : current);
    setApiBaseUrl(current => current === previous?.apiBaseUrl ? settings.apiBaseUrl : current);
    setRetrievalApiBaseUrl(current => current === previous?.retrievalApiBaseUrl ? settings.retrievalApiBaseUrl : current);
    setReasoningEffort(current => current === previous?.reasoningEffort ? settings.reasoningEffort : current);
    setWebSearchPolicy(current => current === previous?.webSearchPolicy ? settings.webSearchPolicy : current);
    setVoiceWebSearchEnabled(current=>current===(previous?.voiceWebSearchEnabled??false)?(settings.voiceWebSearchEnabled??false):current);
    setAiEnabled(current => current === previous?.aiEnabled ? settings.aiEnabled : current);
    previousSettings.current = settings;
  }, [settings]);

  if (!settings) return <div className="loading-state" role="status"><LoaderCircle className="spin" size={18}/><span>正在读取设置…</span></div>;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (section === 'model' && (connectionTab === 'asr' || connectionTab === 'tts')) return;
    setBusy(true);
    setTestResult(null); setTestFailed(false);
    try {
      const next = await api.patch<AppSettings>('/settings', connectionTab === 'chat' ? { model, apiBaseUrl, reasoningEffort, aiEnabled, webSearchPolicy,voiceWebSearchEnabled, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) } : connectionTab === 'vision' ? { visionModel,visionApiBaseUrl,...(visionApiKey.trim()?{visionApiKey:visionApiKey.trim()}:{}) } : connectionTab === 'retrieval' ? { embeddingModel, rerankerModel, retrievalApiBaseUrl, ...(retrievalApiKey.trim() ? { retrievalApiKey: retrievalApiKey.trim() } : {}) } : {});
      if (section === 'model') {
        if (connectionTab === 'chat') setApiKey('');
        if (connectionTab === 'vision') setVisionApiKey('');
        if (connectionTab === 'retrieval') setRetrievalApiKey('');
      }
      onSaved(next);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '模型设置保存失败。');
    } finally {
      setBusy(false);
    }
  };

  const testVisionConnection=async()=>{
    setBusy(true);setTestResult(null);setTestFailed(false);
    try{
      const next=await api.patch<AppSettings>('/settings',{visionModel,visionApiBaseUrl,...(visionApiKey.trim()?{visionApiKey:visionApiKey.trim()}:{})});
      setVisionApiKey('');onSaved(next);
      const result=await api.post<{message:string}>('/settings/test-vision');setTestResult(`视觉连接正常：${result.message}`);
    }catch(reason){setTestFailed(true);setTestResult(reason instanceof Error?reason.message:'视觉连接测试失败。');}
    finally{setBusy(false);}
  };
  const clearVisionKey=async()=>{
    setBusy(true);
    try{const next=await api.patch<AppSettings>('/settings',{clearVisionApiKey:true});setVisionApiKey('');onSaved(next);}
    catch(reason){onError(reason instanceof Error?reason.message:'视觉密钥清除失败。');}
    finally{setBusy(false);}
  };

  const testNetworkConnection=async()=>{
    setBusy(true);setTestResult(null);setTestFailed(false);
    try{
      const next=await api.patch<AppSettings>('/settings',{model,apiBaseUrl,reasoningEffort,aiEnabled,webSearchPolicy,voiceWebSearchEnabled,...(apiKey.trim()?{apiKey:apiKey.trim()}:{})});
      setApiKey('');onSaved(next);
      const result=await api.post<{message:string}>('/settings/test-web-search');setTestResult(result.message);
    }catch(reason){setTestFailed(true);setTestResult(reason instanceof Error?reason.message:'联网测试未完成，请核对服务是否支持搜索接口。');}
    finally{setBusy(false);}
  };

  const testConnection = async () => {
    setBusy(true);
    setTestResult(null); setTestFailed(false);
    try {
      let next = settings;
      if (apiKey.trim() || model !== settings.model || apiBaseUrl !== settings.apiBaseUrl || reasoningEffort !== settings.reasoningEffort || aiEnabled!==settings.aiEnabled || webSearchPolicy!==settings.webSearchPolicy || voiceWebSearchEnabled!==(settings.voiceWebSearchEnabled??false)) {
        next = await api.patch<AppSettings>('/settings', { model, apiBaseUrl, reasoningEffort, aiEnabled, webSearchPolicy,voiceWebSearchEnabled, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
        setApiKey('');
        onSaved(next);
      }
      const result = await api.post<{ message: string }>('/settings/test');
      setTestResult(`连接正常：${result.message}`);
    } catch (reason) {
      setTestFailed(true);
      setTestResult(reason instanceof Error ? reason.message : '连接测试失败。');
    } finally {
      setBusy(false);
    }
  };

  const detectModels = async () => {
    setModelBusy(true);
    setTestResult(null); setTestFailed(false);
    try {
      const result = await api.post<{ models: string[] }>('/settings/models', { apiBaseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      setAvailableModels(result.models);
      if (result.models.length && !result.models.includes(model)) setModel(result.models[0]);
      setTestResult(result.models.length ? `检测成功：找到 ${result.models.length} 个可用模型。` : '服务商没有返回模型列表，可以手动填写模型名称。');
    } catch (reason) {
      setTestFailed(true);
      setTestResult(reason instanceof Error ? reason.message : '模型检测失败。');
    } finally {
      setModelBusy(false);
    }
  };

  const testRetrievalConnection = async () => {
    setBusy(true);
    setTestResult(null); setTestFailed(false);
    try {
      let next = settings;
      if (retrievalApiKey.trim() || retrievalApiBaseUrl !== settings.retrievalApiBaseUrl || embeddingModel !== settings.embeddingModel || rerankerModel !== settings.rerankerModel) {
        next = await api.patch<AppSettings>('/settings', { retrievalApiBaseUrl, embeddingModel, rerankerModel, ...(retrievalApiKey.trim() ? { retrievalApiKey: retrievalApiKey.trim() } : {}) });
        setRetrievalApiKey('');
        onSaved(next);
      }
      const result = await api.post<{ message: string }>('/settings/test-retrieval');
      setTestResult(`检索连接正常：${result.message}`);
    } catch (reason) {
      setTestFailed(true);
      setTestResult(reason instanceof Error ? reason.message : '检索连接测试失败。');
    } finally {
      setBusy(false);
    }
  };


  const clearSessionKey = async () => {
    setBusy(true);
    try {
      const next = await api.patch<AppSettings>('/settings', { clearSessionKey: true, aiEnabled: false });
      setAiEnabled(false);
      setApiKey('');
      setTestResult(null); setTestFailed(false);
      onSaved(next);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '密钥清除失败。');
    } finally {
      setBusy(false);
    }
  };

  const clearRetrievalKey = async () => {
    setBusy(true);
    try {
      const next = await api.patch<AppSettings>('/settings', { clearRetrievalApiKey: true });
      setRetrievalApiKey('');
      setTestResult(null); setTestFailed(false);
      onSaved(next);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '检索密钥清除失败。');
    } finally {
      setBusy(false);
    }
  };


  const checkLatestUpdate = async () => {
    setReleaseAction('checking');
    setReleaseMessage(null);
    try {
      const latest = await api.get<ClientRelease>('/releases/latest');
      setRelease(latest);
      setReleaseMessage(isNewerClientVersion(latest.version, CLIENT_VERSION) ? `发现新版本 ${latest.version}，可以下载安装。` : '当前已经是最新版。');
    } catch (reason) {
      setRelease(null);
      onError(reason instanceof Error ? reason.message : '检查更新失败，请确认已连接服务器。');
    } finally {
      setReleaseAction('idle');
    }
  };

  const installLatestUpdate = async () => {
    if (!release || !isNewerClientVersion(release.version, CLIENT_VERSION)) return;
    if (!window.aiSecretary) {
      onError('请在安装版 AI 秘书中执行客户端更新。');
      return;
    }
    setReleaseAction('downloading');
    setReleaseMessage('正在下载安装包并校验，请不要关闭应用。');
    try {
      const result = await window.aiSecretary.installLatestUpdate();
      setRelease(result.release);
      setReleaseMessage(result.status === 'up-to-date' ? '当前已经是最新版。' : '安装包已准备完成，即将关闭应用并打开安装程序…');
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '下载安装包失败，请确认已连接服务器。');
    } finally {
      setReleaseAction('idle');
    }
  };

  const keyState = settings.apiKeySource === 'environment' ? '环境变量中已配置' : settings.apiKeySource === 'device' ? '已保存在本机' : settings.apiKeySource === 'session' ? '本次运行已配置' : '尚未配置密钥';
  const retrievalKeyState = settings.retrievalApiKeySource === 'fallback' ? '复用对话密钥' : settings.hasRetrievalApiKey ? '已配置独立密钥' : '尚未配置密钥';
  const visionKeyState=settings.visionApiKeySource==='fallback'?'复用对话密钥':settings.hasVisionApiKey?'已配置独立密钥':'尚未配置密钥';
  const hasUsableRetrievalKey = Boolean(retrievalApiKey.trim()) || (settings.hasRetrievalApiKey && settings.retrievalApiKeySource !== 'fallback') || (retrievalApiBaseUrl.replace(/\/+$/, '') === apiBaseUrl.replace(/\/+$/, '') && settings.hasApiKey);
  return <div className="settings-page surface-page settings-hierarchy">
    <header className="page-header"><div><h1>设置</h1></div></header>
    <nav className="subpage-nav settings-primary-nav" aria-label="设置页面">{settingsSections.map(({id,title,icon:Icon})=><button key={id} className={section===id?'active':''} aria-current={section===id?'page':undefined} type="button" disabled={busy||modelBusy} onClick={()=>{setSection(id);setTestResult(null);}}><Icon size={14} aria-hidden="true"/><span>{title}</span></button>)}</nav>
    {section==='companion'?<div className="settings-form subpage-panel companion-settings-form"><CompanionSettings onError={onError} settings={settings} startOnVoiceDevices={openCompanionDevices} onOpenModel={purpose=>{setConnectionTab(purpose);setSection('model');}}/></div>:<form className={`settings-form subpage-panel ${section==='model'?'connection-form':''}`} onSubmit={save}>
      {section==='update'?<section className="settings-section single-setting-section">
        <SettingsPaneHeading title="客户端更新" description="查看当前版本与可用更新。"/>
        <div className="client-update-row">
          <div><span>当前版本</span><strong>{CLIENT_VERSION}</strong></div>
          <div><span>服务器版本</span><strong>{release?.version??'尚未检查'}</strong></div>
          <div><span>安装包大小</span><strong>{release?`${(release.size/1024/1024).toFixed(1)} MB`:'—'}</strong></div>
        </div>
        {releaseMessage?<FeedbackBanner>{releaseMessage}</FeedbackBanner>:null}
        <div className="settings-actions client-update-actions"><span/><button className="secondary-button" type="button" disabled={releaseAction!=='idle'} onClick={()=>void checkLatestUpdate()}>{releaseAction==='checking'?<><LoaderCircle className="spin" size={15}/>正在检查…</>:<><RefreshCw size={15}/>{release?'重新检查':'检查更新'}</>}</button>{release&&isNewerClientVersion(release.version,CLIENT_VERSION)?<button className="primary-button" type="button" disabled={releaseAction!=='idle'} onClick={()=>void installLatestUpdate()}>{releaseAction==='downloading'?<><LoaderCircle className="spin" size={15}/>正在下载…</>:<><Download size={15}/>下载并安装 {release.version}</>}</button>:null}</div>
      </section>:<section className="settings-section single-setting-section connection-settings">
        <div className="connection-layout">
          <nav className="connection-nav" aria-label="连接类型">
            {([{id:'chat',title:'对话模型',detail:'理解需求、回答与记忆',configured:settings.hasApiKey,icon:MessageSquare},{id:'vision',title:'视觉模型',detail:'按需理解摄像头画面',configured:settings.hasVisionApiKey??settings.hasApiKey,icon:Eye},{id:'asr',title:'语音识别',detail:'把声音转成文字',configured:settings.speechExecution==='local'||Boolean(settings.speechRealtimeRecognitionModel||settings.speechRecognitionModel),icon:Mic},{id:'tts',title:'语音合成',detail:'把回答读出来',configured:settings.speechExecution==='local'||Boolean(settings.speechRealtimeSynthesisModel||settings.speechSynthesisModel),icon:Volume2},{id:'retrieval',title:'知识检索',detail:'查找资料与排序',configured:settings.hasRetrievalApiKey,icon:Search}] as const).map(item=><button type="button" key={item.id} aria-pressed={connectionTab===item.id} title={item.detail} disabled={busy||modelBusy} onClick={()=>{if(connectionDetailRef.current)connectionDetailRef.current.scrollTop=0;setConnectionTab(item.id);setTestResult(null);setTestFailed(false);}}><item.icon size={16} aria-hidden="true"/><span><strong>{item.title}</strong><em>{(item.id==='asr'||item.id==='tts')&&settings.speechExecution==='local'?'本机运行':item.configured?'已配置':'待配置'}</em></span></button>)}
          </nav>
          <div className="connection-detail" ref={connectionDetailRef}>
            <fieldset className="settings-fields connection-fields settings-connection-fields" hidden={connectionTab!=='chat'} disabled={connectionTab!=='chat'||busy}>
              <SettingsPaneHeading title="对话模型" description={aiEnabled?'文字与语音共用，理解需求并调用工具。':'模型回答已关闭，仍可检索已有资料。'}><label className="settings-header-toggle"><span>启用回答</span><input type="checkbox" checked={aiEnabled} onChange={event=>setAiEnabled(event.target.checked)}/></label></SettingsPaneHeading>
              <SettingsGroup title="服务连接" note={settings.hasApiKey?'密钥已配置':'待配置密钥'}>
                <label className="wide-setting"><span>服务地址</span><input type="url" required maxLength={500} value={apiBaseUrl} onChange={event=>setApiBaseUrl(event.target.value)} placeholder="例如：https://api.deepseek.com"/></label>
                <label className="wide-setting"><span>API Key</span><div className="secret-input"><KeyRound size={14} aria-hidden="true"/><input type="password" autoComplete="off" maxLength={300} value={apiKey} onChange={event=>setApiKey(event.target.value)} placeholder={settings.hasApiKey?'已配置，留空保留当前密钥':'填写服务商提供的 API Key'}/></div></label>
                <div className="wide-setting"><SettingsHelp title="地址与密钥如何填写"><p>使用 OpenAI 兼容接口。DeepSeek 官方地址为 https://api.deepseek.com；使用中转时填写中转地址。</p><p>{keyState}。密钥留空表示不更换。关闭“启用回答”会暂停模型生成与 Agent 执行。</p></SettingsHelp></div>
              </SettingsGroup>
              <SettingsGroup title="回答偏好">
                <label><span>默认模型</span><div className="model-picker">{availableModels.length?<StyledSelect value={model} onChange={event=>setModel(event.target.value)}>{availableModels.map(item=><option value={item} key={item}>{item}</option>)}</StyledSelect>:<input required maxLength={120} value={model} onChange={event=>setModel(event.target.value)} placeholder="填写模型 ID"/>}<button className="secondary-button" type="button" disabled={modelBusy||!apiBaseUrl.trim()||(!settings.hasApiKey&&!apiKey.trim())} onClick={detectModels}>{modelBusy?'检测中…':'检测模型'}</button></div></label>
                <label><span>思考深度</span><StyledSelect value={reasoningEffort} onChange={event=>setReasoningEffort(event.target.value as AppSettings['reasoningEffort'])}><option value="auto">自动 · 按任务判断</option><option value="low">快速 · 优先响应</option><option value="medium">标准 · 日常分析</option><option value="high">深入 · 复杂问题</option></StyledSelect></label>
                <p className="settings-group-note wide-setting">也可在对话中说“认真分析”或“简单说”，临时调整本次任务。</p>
              </SettingsGroup>
              <SettingsGroup title="联网策略" note="复用对话连接">
                <label><span>何时联网</span><StyledSelect value={webSearchPolicy} onChange={event=>setWebSearchPolicy(event.target.value as AppSettings['webSearchPolicy'])}><option value="off">关闭 · 只使用已有资料</option><option value="ask">需要时先询问</option><option value="auto">需要时自动联网</option></StyledSelect></label>
                <label className="settings-inline-toggle"><span><strong>生活语音可联网</strong><small>遵循当前策略</small></span><input type="checkbox" checked={voiceWebSearchEnabled} onChange={event=>setVoiceWebSearchEnabled(event.target.checked)}/></label>
                <div className="settings-group-footer wide-setting"><SettingsHelp title="联网支持说明"><p>DeepSeek Search / Fetch 共用对话地址和密钥。中转服务需要支持搜索与网页读取接口。</p></SettingsHelp><button type="button" className="secondary-button" disabled={busy||modelBusy||!apiBaseUrl.trim()||(!settings.hasApiKey&&!apiKey.trim())} onClick={()=>void testNetworkConnection()}>保存并测试联网</button></div>
              </SettingsGroup>
            </fieldset>
            {connectionTab==='chat'?<VoiceAnswerSettings settings={settings} availableModels={availableModels}/>:null}
            <fieldset className="settings-fields connection-fields settings-connection-fields" hidden={connectionTab!=='vision'} disabled={connectionTab!=='vision'||busy}>
              <SettingsPaneHeading title="视觉模型" description="按需读取一帧摄像头画面，原图不保存。"/>
              <SettingsGroup title="服务连接" note={visionKeyState}>
                <label className="wide-setting"><span>服务地址</span><input type="url" maxLength={500} value={visionApiBaseUrl} onChange={event=>setVisionApiBaseUrl(event.target.value)} placeholder="留空跟随对话服务地址"/></label>
                <label className="wide-setting"><span>API Key</span><div className="secret-input"><KeyRound size={14} aria-hidden="true"/><input type="password" autoComplete="off" maxLength={300} value={visionApiKey} onChange={event=>setVisionApiKey(event.target.value)} placeholder={settings.visionApiKeySource==='fallback'?'复用同一服务的对话密钥':settings.hasVisionApiKey?'已配置，留空保留当前密钥':'填写视觉服务商的 API Key'}/></div></label>
              </SettingsGroup>
              <SettingsGroup title="图像理解">
                <label className="wide-setting"><span>视觉模型 ID</span><input required maxLength={160} value={visionModel} onChange={event=>setVisionModel(event.target.value)} placeholder="例如：qwen3-vl-flash"/></label>
                <div className="wide-setting"><SettingsHelp title="视觉连接规则"><p>请选择支持图片输入的模型，可以独立使用千问等服务。独立密钥单独保存；只有地址相同时，才允许复用对话密钥。</p><p>更换对话连接时，已复用的视觉连接会保留原地址和密钥。</p></SettingsHelp></div>
              </SettingsGroup>
            </fieldset>
            {connectionTab==='asr'||connectionTab==='tts'?<VoiceConnectionSettings key={connectionTab} purpose={connectionTab} settings={settings} onSaved={onSaved} onOpenVoiceDevices={()=>{setOpenCompanionDevices(true);setSection('companion');}} onOpenChat={()=>setConnectionTab('chat')}/>:null}
            <fieldset className="settings-fields connection-fields settings-connection-fields" hidden={connectionTab!=='retrieval'} disabled={connectionTab!=='retrieval'||busy}>
              <SettingsPaneHeading title="知识检索" description="从已有文档中召回内容，并筛选更相关的结果。"/>
              <SettingsGroup title="服务连接" note={retrievalKeyState}>
                <label className="wide-setting"><span>服务地址</span><input type="url" required maxLength={500} value={retrievalApiBaseUrl} onChange={event=>setRetrievalApiBaseUrl(event.target.value)} placeholder="例如：https://api.siliconflow.cn/v1"/></label>
                <label className="wide-setting"><span>API Key</span><div className="secret-input"><KeyRound size={14} aria-hidden="true"/><input type="password" autoComplete="off" maxLength={300} value={retrievalApiKey} onChange={event=>setRetrievalApiKey(event.target.value)} placeholder={settings.retrievalApiKeySource==='fallback'?'复用对话密钥，填写后独立配置':settings.hasRetrievalApiKey?'已配置，留空保留当前密钥':'填写检索服务商的 API Key'}/></div></label>
              </SettingsGroup>
              <SettingsGroup title="检索模型">
                <label><span>语义向量模型</span><input required maxLength={160} value={embeddingModel} onChange={event=>setEmbeddingModel(event.target.value)} placeholder="BAAI/bge-m3"/></label>
                <label><span>重排模型</span><input required maxLength={160} value={rerankerModel} onChange={event=>setRerankerModel(event.target.value)} placeholder="BAAI/bge-reranker-v2-m3"/></label>
                <div className="wide-setting"><SettingsHelp title="模型兼容说明"><p>服务需要支持 OpenAI Embeddings 接口和所选向量模型。默认 BGE-M3 使用 1024 维向量。</p><p>不支持 /rerank 时会降级为 RRF 排名。检索可以使用独立的服务地址和密钥。</p></SettingsHelp></div>
              </SettingsGroup>
            </fieldset>
            {testResult?<FeedbackBanner tone={testFailed?'error':'success'}>{testResult}</FeedbackBanner>:null}
            {connectionTab!=='asr'&&connectionTab!=='tts'?<div className="connection-savebar">
              <p>仅保存当前连接</p>
              <div className="connection-save-actions">
                <div>{connectionTab==='chat'&&['session','device'].includes(settings.apiKeySource)?<button className="text-danger-button" type="button" disabled={busy||modelBusy} onClick={clearSessionKey}>清除对话密钥</button>:connectionTab==='vision'&&['session','device'].includes(settings.visionApiKeySource??'none')?<button className="text-danger-button" type="button" disabled={busy||modelBusy} onClick={clearVisionKey}>清除视觉密钥</button>:connectionTab==='retrieval'&&['session','device'].includes(settings.retrievalApiKeySource)?<button className="text-danger-button" type="button" disabled={busy||modelBusy} onClick={clearRetrievalKey}>清除检索密钥</button>:null}</div>
                <button className="secondary-button" type="button" disabled={busy||modelBusy||(connectionTab==='chat'?!apiBaseUrl.trim()||!model.trim()||(!settings.hasApiKey&&!apiKey.trim()):connectionTab==='vision'?!visionModel.trim():!retrievalApiBaseUrl.trim()||!embeddingModel.trim()||!hasUsableRetrievalKey)} onClick={connectionTab==='chat'?testConnection:connectionTab==='vision'?testVisionConnection:testRetrievalConnection}>{busy?'处理中…':'保存并测试'}</button>
                <button className="primary-button" type="submit" disabled={busy||modelBusy||(connectionTab==='chat'?!apiBaseUrl.trim()||!model.trim():connectionTab==='vision'?!visionModel.trim():connectionTab==='retrieval'?!retrievalApiBaseUrl.trim()||!embeddingModel.trim()||!rerankerModel.trim():false)}>{busy?'正在保存…':'保存当前连接'}</button>
              </div>
            </div>:null}
          </div>
        </div>
      </section>}
    </form>}
  </div>;
}
