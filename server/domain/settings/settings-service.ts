import { database, nowIso } from '../../db.js';
import { qwenRealtimeUrl } from '../../providers/qwen-realtime-asr.js';
import { validateRealtimeRecognition } from '../../providers/configured-realtime-asr.js';
import {isDeepSeek} from '../../providers/model-reasoning.js';

export type DeviceSecretStore = { load: () => string | null; save: (value: string) => void; clear: () => void };
export type WebSearchPolicy = 'off' | 'ask' | 'auto';
export type SettingsUpdate = { speechExecution?: 'local' | 'cloud'; voiceWebSearchEnabled?: boolean; aiEnabled?: boolean; model?: string; visionModel?: string; visionApiBaseUrl?:string; visionApiKey?:string; clearVisionApiKey?:boolean; speechRecognitionModel?: string; speechRealtimeRecognitionModel?: string; speechSynthesisModel?: string; speechRealtimeSynthesisModel?: string; speechRealtimeSynthesisBaseUrl?: string; speechRealtimeVoice?: string; speechServiceBaseUrl?: string; speechLegacyRecognitionBaseUrl?: string; speechLegacySynthesisBaseUrl?: string; speechVoice?: string; speechInstruction?: string; embeddingModel?: string; rerankerModel?: string; apiBaseUrl?: string; retrievalApiBaseUrl?: string; reasoningEffort?: string; webSearchPolicy?: string; apiKey?: string; retrievalApiKey?: string; webSearchApiKey?: string; clearSessionKey?: boolean; clearRetrievalApiKey?: boolean; clearWebSearchApiKey?: boolean; vaultPath?: string; syncEnabled?: boolean; syncDeviceName?: string };

function getSetting(key: string, fallback: string) {
  const row = database.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

function setSetting(key: string, value: string) {
  database.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, nowIso());
}

function hasSetting(key: string) {
  return Boolean(database.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(key));
}

export class SettingsService {
  private deviceApiKey: string | null;
  private sessionApiKey: string | null = null;
  private deviceRetrievalApiKey: string | null;
  private sessionRetrievalApiKey: string | null = null;
  private deviceWebSearchApiKey: string | null;
  private sessionWebSearchApiKey: string | null = null;
  private deviceVisionApiKey: string | null;
  private sessionVisionApiKey: string | null = null;

  constructor(private readonly secretStore?: DeviceSecretStore, private readonly retrievalSecretStore?: DeviceSecretStore, private readonly webSearchSecretStore?: DeviceSecretStore, private readonly visionSecretStore?:DeviceSecretStore) {
    try { this.deviceApiKey = secretStore?.load() ?? null; } catch { this.deviceApiKey = null; }
    try { this.deviceRetrievalApiKey = retrievalSecretStore?.load() ?? null; } catch { this.deviceRetrievalApiKey = null; }
    try { this.deviceWebSearchApiKey = webSearchSecretStore?.load() ?? null; } catch { this.deviceWebSearchApiKey = null; }
    try { this.deviceVisionApiKey = visionSecretStore?.load() ?? null; } catch { this.deviceVisionApiKey = null; }
  }

  nativeVoiceConnection() {
    if (getSetting('speech_execution', 'local') === 'local') return {
      speechExecution: 'local' as const, speechServiceBaseUrl: 'local://asr', speechRealtimeRecognitionModel: 'zipformer-local',
      synthesisBaseUrl: 'local://tts', synthesisModel: 'moss-local', voice: 'xiwei-sweet-soft'
    };
    return {
      speechServiceBaseUrl: getSetting('speech_service_base_url', ''),
      speechRealtimeRecognitionModel: getSetting('speech_realtime_recognition_model', ''),
      synthesisBaseUrl: getSetting('speech_realtime_synthesis_base_url', ''),
      synthesisModel: getSetting('speech_realtime_synthesis_model', ''),
      voice: getSetting('speech_realtime_voice', '')
    };
  }

  effectiveApiKey() {
    return this.sessionApiKey || this.deviceApiKey || process.env.AI_SECRETARY_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || null;
  }

  effectiveRetrievalApiKey() {
    const dedicatedKey = this.sessionRetrievalApiKey || this.deviceRetrievalApiKey || process.env.AI_SECRETARY_RETRIEVAL_API_KEY?.trim() || null;
    if (dedicatedKey) return dedicatedKey;
    const apiBaseUrl = getSetting('api_base_url', process.env.AI_SECRETARY_API_BASE_URL?.trim() ?? '');
    const retrievalApiBaseUrl = getSetting('retrieval_api_base_url', process.env.AI_SECRETARY_RETRIEVAL_API_BASE_URL?.trim() ?? '');
    return !retrievalApiBaseUrl || retrievalApiBaseUrl === apiBaseUrl ? this.effectiveApiKey() : null;
  }

  effectiveWebSearchApiKey() {
    return this.sessionWebSearchApiKey || this.deviceWebSearchApiKey || process.env.AI_SECRETARY_TAVILY_API_KEY?.trim() || process.env.TAVILY_API_KEY?.trim() || null;
  }

  effectiveVisionApiKey() {
    const dedicated=this.sessionVisionApiKey||this.deviceVisionApiKey||process.env.AI_SECRETARY_VISION_API_KEY?.trim();
    if(dedicated)return dedicated;
    const base=getSetting('api_base_url',process.env.AI_SECRETARY_API_BASE_URL?.trim()??'');
    const visionBase=getSetting('vision_api_base_url','');
    return !visionBase||visionBase===base?this.effectiveApiKey():null;
  }

  private saveVisionKey(value:string) {
    if(this.visionSecretStore){try{this.visionSecretStore.save(value);this.deviceVisionApiKey=value;this.sessionVisionApiKey=null;return;}catch{/* Session storage remains available. */}}
    this.sessionVisionApiKey=value;
  }

  current() {
    const environmentKey = Boolean(process.env.AI_SECRETARY_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());
    const retrievalEnvironmentKey = Boolean(process.env.AI_SECRETARY_RETRIEVAL_API_KEY?.trim());
    const webSearchEnvironmentKey = Boolean(process.env.AI_SECRETARY_TAVILY_API_KEY?.trim() || process.env.TAVILY_API_KEY?.trim());
    const apiBaseUrl = getSetting('api_base_url', process.env.AI_SECRETARY_API_BASE_URL?.trim() ?? '');
    const savedRetrievalApiBaseUrl = getSetting('retrieval_api_base_url', process.env.AI_SECRETARY_RETRIEVAL_API_BASE_URL?.trim() ?? '');
    const deepseekSearch=isDeepSeek(getSetting('ai_model',''),apiBaseUrl);
    const mayFallbackToConversationKey = !savedRetrievalApiBaseUrl || savedRetrievalApiBaseUrl === apiBaseUrl;
    const visionApiBaseUrl=getSetting('vision_api_base_url','');
    const visionApiKeySource=this.sessionVisionApiKey?'session' as const:this.deviceVisionApiKey?'device' as const:process.env.AI_SECRETARY_VISION_API_KEY?.trim()?'environment' as const:(!visionApiBaseUrl||visionApiBaseUrl===apiBaseUrl)&&this.effectiveApiKey()?'fallback' as const:'none' as const;
    const retrievalApiKeySource = this.sessionRetrievalApiKey ? 'session' as const : this.deviceRetrievalApiKey ? 'device' as const : retrievalEnvironmentKey ? 'environment' as const : mayFallbackToConversationKey && this.effectiveApiKey() ? 'fallback' as const : 'none' as const;
    const documentCount = database.prepare(`SELECT COUNT(*) AS count FROM knowledge_documents`).get() as { count: number };
    const chunkCount = database.prepare(`SELECT COUNT(*) AS count FROM knowledge_chunks`).get() as { count: number };
    return {
      provider: 'openai-compatible' as const,
      speechExecution: getSetting('speech_execution', 'local') as 'local' | 'cloud',
      aiEnabled: getSetting('ai_enabled', '0') === '1', model: getSetting('ai_model', ''),
      visionModel: getSetting('vision_model', 'qwen3-vl-flash'),
      visionApiBaseUrl,hasVisionApiKey:Boolean(this.effectiveVisionApiKey()),visionApiKeySource,
      speechRecognitionModel: getSetting('speech_recognition_model', 'qwen-audio-3.0-asr-flash'),
      speechRealtimeRecognitionModel: getSetting('speech_realtime_recognition_model', ''),
      speechRealtimeSynthesisModel: getSetting('speech_realtime_synthesis_model', ''),
      speechRealtimeSynthesisBaseUrl: getSetting('speech_realtime_synthesis_base_url', ''),
      speechRealtimeVoice: getSetting('speech_realtime_voice', ''),
      speechSynthesisModel: getSetting('speech_synthesis_model', 'qwen-audio-3.0-tts-flash'),
      speechServiceBaseUrl: getSetting('speech_service_base_url', ''),
      speechLegacyRecognitionBaseUrl: getSetting('speech_legacy_recognition_base_url', getSetting('speech_service_base_url', '')),
      speechLegacySynthesisBaseUrl: getSetting('speech_legacy_synthesis_base_url', getSetting('speech_service_base_url', '')),
      speechVoice: getSetting('speech_voice', 'longanhuan_v3.6'),
      speechInstruction: getSetting('speech_instruction', '年轻女性声线，温柔干练，自然口语化，语速稍快，情绪克制但有温度。'),
      apiBaseUrl,
      retrievalApiBaseUrl: savedRetrievalApiBaseUrl || apiBaseUrl,
      reasoningEffort: getSetting('reasoning_effort', 'auto') as 'auto' | 'low' | 'medium' | 'high',
      embeddingModel: getSetting('embedding_model', 'BAAI/bge-m3'), rerankerModel: getSetting('reranker_model', 'BAAI/bge-reranker-v2-m3'),
      hasApiKey: Boolean(this.effectiveApiKey()), apiKeySource: this.sessionApiKey ? 'session' as const : this.deviceApiKey ? 'device' as const : environmentKey ? 'environment' as const : 'none' as const,
      hasRetrievalApiKey: Boolean(this.effectiveRetrievalApiKey()), retrievalApiKeySource,
      voiceWebSearchEnabled: getSetting('voice_web_search_enabled', '0') === '1',
      webSearchPolicy: getSetting('web_search_policy', 'ask') as WebSearchPolicy,
      hasWebSearchApiKey: deepseekSearch?Boolean(this.effectiveApiKey()):Boolean(this.effectiveWebSearchApiKey()),
      webSearchProvider:deepseekSearch?'deepseek' as const:this.effectiveWebSearchApiKey()?'tavily' as const:'none' as const,
      webSearchApiKeySource:deepseekSearch&&this.effectiveApiKey()?'model' as const:this.sessionWebSearchApiKey ? 'session' as const : this.deviceWebSearchApiKey ? 'device' as const : webSearchEnvironmentKey ? 'environment' as const : 'none' as const,
      vaultPath: getSetting('vault_path', ''), vaultLastScannedAt: getSetting('vault_last_scanned_at', '') || null,
      syncEnabled: getSetting('sync_enabled', '0') === '1', syncDeviceName: getSetting('sync_device_name', ''),
      knowledgeDocumentCount: documentCount.count, knowledgeChunkCount: chunkCount.count
    };
  }

  update(body: SettingsUpdate) {
    const previous=this.current(),previousKey=this.effectiveApiKey();
    for(const field of ['apiKey','retrievalApiKey','webSearchApiKey','visionApiKey'] as const){const value=body[field];if(value!==undefined&&(typeof value!=='string'||value.trim().length<20||value.trim().length>300))throw Object.assign(new Error('API Key 格式不完整，请重新复制。'),{statusCode:400});}
    if(body.visionApiBaseUrl!==undefined){try{if(typeof body.visionApiBaseUrl!=='string')throw Error();if(body.visionApiBaseUrl.trim()){const url=new URL(body.visionApiBaseUrl.trim());if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||body.visionApiBaseUrl.length>500)throw Error();}}catch{throw Object.assign(new Error('视觉服务地址格式不正确，请填写完整的 http:// 或 https:// 地址，或留空跟随对话连接。'),{statusCode:400});}}
    if (body.speechExecution !== undefined && !['local','cloud'].includes(body.speechExecution)) throw Object.assign(new Error('请选择本机或云端语音。'), { statusCode: 400 });
    if (body.model !== undefined && (!body.model.trim() || body.model.trim().length > 120 || !/^[a-zA-Z0-9._:/-]+$/.test(body.model.trim()))) throw Object.assign(new Error('模型名称格式不正确，请按服务商提供的名称填写。'), { statusCode: 400 });
    for (const [label, value] of [['视觉', body.visionModel], ['语音识别', body.speechRecognitionModel], ['语音合成', body.speechSynthesisModel], ['Embedding', body.embeddingModel], ['Reranker', body.rerankerModel]] as const) if (value !== undefined && (!value.trim() || value.trim().length > 160 || !/^[a-zA-Z0-9._:/-]+$/.test(value.trim()))) throw Object.assign(new Error(`${label} 模型名称格式不正确。`), { statusCode: 400 });
    const nextBaseUrl = body.apiBaseUrl?.trim().replace(/\/+$/, '') ?? this.current().apiBaseUrl;
    const nextRetrievalBaseUrl = body.retrievalApiBaseUrl?.trim().replace(/\/+$/, '') ?? this.current().retrievalApiBaseUrl;
    const nextSpeechBaseUrl = body.speechServiceBaseUrl?.trim().replace(/\/+$/, '') ?? this.current().speechServiceBaseUrl;
    const nextLegacyRecognitionBaseUrl = body.speechLegacyRecognitionBaseUrl?.trim().replace(/\/+$/, '');
    const nextLegacySynthesisBaseUrl = body.speechLegacySynthesisBaseUrl?.trim().replace(/\/+$/, '');
    for (const [label, value] of [['服务地址', body.apiBaseUrl === undefined ? undefined : nextBaseUrl], ['检索服务地址', body.retrievalApiBaseUrl === undefined ? undefined : nextRetrievalBaseUrl], ['实时识别服务地址', body.speechServiceBaseUrl === undefined ? undefined : nextSpeechBaseUrl], ['兼容识别服务地址', nextLegacyRecognitionBaseUrl], ['兼容合成服务地址', nextLegacySynthesisBaseUrl]] as const) if (value !== undefined && value !== '') {
      try { const parsed = new URL(value); if (!['https:', 'http:'].includes(parsed.protocol) || value.length > 500) throw new Error(); }
      catch { throw Object.assign(new Error(`${label}格式不正确，请填写完整的 http:// 或 https:// 地址。`), { statusCode: 400 }); }
    }
    if (body.speechRealtimeRecognitionModel !== undefined && typeof body.speechRealtimeRecognitionModel !== 'string') throw Object.assign(new Error('实时识别模型格式不正确。'), { statusCode: 400 });
    const realtimeModel = body.speechRealtimeRecognitionModel?.trim() ?? this.current().speechRealtimeRecognitionModel;
    if (realtimeModel && (body.speechRealtimeRecognitionModel !== undefined || body.speechServiceBaseUrl !== undefined)) {
      try { validateRealtimeRecognition({ speechServiceBaseUrl: nextSpeechBaseUrl, speechRealtimeRecognitionModel: realtimeModel }); }
      catch { throw Object.assign(new Error('请填写支持当前实时协议的千问模型与官方语音服务地址。'), { statusCode: 400 }); }
    }
    if (body.reasoningEffort !== undefined && !['auto', 'low', 'medium', 'high'].includes(body.reasoningEffort)) throw Object.assign(new Error('请选择可用的思考深度。'), { statusCode: 400 });
    if (body.webSearchPolicy !== undefined && !['off', 'ask', 'auto'].includes(body.webSearchPolicy)) throw Object.assign(new Error('请选择可用的联网搜索策略。'), { statusCode: 400 });
    const realtimeFields = ['speechRealtimeSynthesisModel', 'speechRealtimeSynthesisBaseUrl', 'speechRealtimeVoice'] as const;
    if (realtimeFields.some(field => body[field] !== undefined)) {
      if (realtimeFields.some(field => body[field] !== undefined && typeof body[field] !== 'string')) throw Object.assign(new Error('实时合成配置格式不正确。'), { statusCode: 400 });
      const saved = this.current();
      const model = (body.speechRealtimeSynthesisModel ?? saved.speechRealtimeSynthesisModel).trim();
      const baseUrl = (body.speechRealtimeSynthesisBaseUrl ?? saved.speechRealtimeSynthesisBaseUrl).trim();
      const voice = (body.speechRealtimeVoice ?? saved.speechRealtimeVoice).trim();
      if (model || baseUrl || voice) {
        try {
          if (!/^qwen3-tts-(?:instruct-)?flash-realtime(?:-[\w.-]+)?$/.test(model) || !/^[\w.-]{1,160}$/.test(voice)) throw Error();
          qwenRealtimeUrl(baseUrl, model);
        } catch { throw Object.assign(new Error('请填写完整且受支持的实时合成地址、模型和音色。'), { statusCode: 400 }); }
      }
    }
    if (body.vaultPath !== undefined && body.vaultPath.trim().length > 1000) throw Object.assign(new Error('Obsidian Vault 路径过长，请检查后重新填写。'), { statusCode: 400 });
    if (body.syncDeviceName !== undefined && (!body.syncDeviceName.trim() || body.syncDeviceName.trim().length > 60)) throw Object.assign(new Error('设备名称需要填写 1 至 60 个字符。'), { statusCode: 400 });
    if (body.syncEnabled === true && !(body.vaultPath ?? this.current().vaultPath).trim()) throw Object.assign(new Error('开启设备同步前，请先选择 Obsidian Vault。'), { statusCode: 400 });
    if (body.speechVoice !== undefined && (!body.speechVoice.trim() || body.speechVoice.trim().length > 120)) throw Object.assign(new Error('语音音色名称格式不正确。'), { statusCode: 400 });
    if (body.speechInstruction !== undefined && body.speechInstruction.trim().length > 500) throw Object.assign(new Error('语音表现指令不能超过 500 个字符。'), { statusCode: 400 });
    // Freeze old fallback profiles BEFORE replacing the chat URL/key. Otherwise
    // a DeepSeek switch would send vision/embedding requests to the wrong API.
    const changingChat=(body.apiBaseUrl!==undefined&&nextBaseUrl!==previous.apiBaseUrl)||(body.apiKey!==undefined&&body.apiKey.trim()!==previousKey);
    if(changingChat){
      if(!previous.visionApiBaseUrl&&body.visionApiBaseUrl===undefined)setSetting('vision_api_base_url',previous.apiBaseUrl);
      if(previous.visionApiKeySource==='fallback'&&previousKey&&body.visionApiKey===undefined&&!body.clearVisionApiKey)this.saveVisionKey(previousKey);
      if(!getSetting('retrieval_api_base_url','')&&body.retrievalApiBaseUrl===undefined)setSetting('retrieval_api_base_url',previous.retrievalApiBaseUrl);
      if(previous.retrievalApiKeySource==='fallback'&&previousKey&&body.retrievalApiKey===undefined&&!body.clearRetrievalApiKey){
        if(this.retrievalSecretStore){try{this.retrievalSecretStore.save(previousKey);this.deviceRetrievalApiKey=previousKey;this.sessionRetrievalApiKey=null;}catch{this.sessionRetrievalApiKey=previousKey;}}
        else this.sessionRetrievalApiKey=previousKey;
      }
    }
    if(body.visionApiKey!==undefined)this.saveVisionKey(body.visionApiKey.trim());
    if(body.clearVisionApiKey){this.sessionVisionApiKey=null;this.deviceVisionApiKey=null;try{this.visionSecretStore?.clear();}catch{/* Memory has already been cleared. */}}
    if (body.apiKey !== undefined) {
      const apiKey = body.apiKey.trim();
      if (apiKey.length < 20 || apiKey.length > 300) throw Object.assign(new Error('API Key 格式不完整，请重新复制。'), { statusCode: 400 });
      if (this.secretStore) { try { this.secretStore.save(apiKey); this.deviceApiKey = apiKey; this.sessionApiKey = null; } catch { this.sessionApiKey = apiKey; } }
      else this.sessionApiKey = apiKey;
    }
    if (body.retrievalApiKey !== undefined) {
      const apiKey = body.retrievalApiKey.trim();
      if (apiKey.length < 20 || apiKey.length > 300) throw Object.assign(new Error('检索 API Key 格式不完整，请重新复制。'), { statusCode: 400 });
      if (this.retrievalSecretStore) { try { this.retrievalSecretStore.save(apiKey); this.deviceRetrievalApiKey = apiKey; this.sessionRetrievalApiKey = null; } catch { this.sessionRetrievalApiKey = apiKey; } }
      else this.sessionRetrievalApiKey = apiKey;
    }
    if (body.webSearchApiKey !== undefined) {
      const apiKey = body.webSearchApiKey.trim();
      if (apiKey.length < 20 || apiKey.length > 300) throw Object.assign(new Error('Tavily API Key 格式不完整，请重新复制。'), { statusCode: 400 });
      if (this.webSearchSecretStore) { try { this.webSearchSecretStore.save(apiKey); this.deviceWebSearchApiKey = apiKey; this.sessionWebSearchApiKey = null; } catch { this.sessionWebSearchApiKey = apiKey; } }
      else this.sessionWebSearchApiKey = apiKey;
    }
    if (body.clearSessionKey) { this.sessionApiKey = null; this.deviceApiKey = null; try { this.secretStore?.clear(); } catch { /* local key is already cleared */ } }
    if (body.clearRetrievalApiKey) { this.sessionRetrievalApiKey = null; this.deviceRetrievalApiKey = null; try { this.retrievalSecretStore?.clear(); } catch { /* local key is already cleared */ } }
    if (body.clearWebSearchApiKey) { this.sessionWebSearchApiKey = null; this.deviceWebSearchApiKey = null; try { this.webSearchSecretStore?.clear(); } catch { /* local key is already cleared */ } }
    if (body.aiEnabled === true && (!this.effectiveApiKey() || !nextBaseUrl)) throw Object.assign(new Error('开启大模型回答前，请填写服务地址和 API Key。'), { statusCode: 400 });
    // The former single URL fed both compatibility providers. Freeze that
    // original value into independent profiles before any new URL is written.
    if ([body.speechServiceBaseUrl, body.speechLegacyRecognitionBaseUrl, body.speechLegacySynthesisBaseUrl].some(value => value !== undefined)) {
      const oldSharedUrl = this.current().speechServiceBaseUrl;
      if (!hasSetting('speech_legacy_recognition_base_url')) setSetting('speech_legacy_recognition_base_url', oldSharedUrl);
      if (!hasSetting('speech_legacy_synthesis_base_url')) setSetting('speech_legacy_synthesis_base_url', oldSharedUrl);
    }
    if (body.model !== undefined) setSetting('ai_model', body.model.trim());
    if (body.visionModel !== undefined) setSetting('vision_model', body.visionModel.trim());
    if(body.visionApiBaseUrl!==undefined)setSetting('vision_api_base_url',body.visionApiBaseUrl.trim().replace(/\/+$/,''));
    if (body.speechRecognitionModel !== undefined) setSetting('speech_recognition_model', body.speechRecognitionModel.trim());
    if (body.speechExecution !== undefined) setSetting('speech_execution', body.speechExecution);
    if (body.speechRealtimeRecognitionModel !== undefined) setSetting('speech_realtime_recognition_model', body.speechRealtimeRecognitionModel.trim());
    if (body.speechRealtimeSynthesisModel !== undefined) setSetting('speech_realtime_synthesis_model', body.speechRealtimeSynthesisModel.trim());
    if (body.speechRealtimeSynthesisBaseUrl !== undefined) setSetting('speech_realtime_synthesis_base_url', body.speechRealtimeSynthesisBaseUrl.trim());
    if (body.speechRealtimeVoice !== undefined) setSetting('speech_realtime_voice', body.speechRealtimeVoice.trim());
    if (body.speechSynthesisModel !== undefined) setSetting('speech_synthesis_model', body.speechSynthesisModel.trim());
    if (body.speechServiceBaseUrl !== undefined) setSetting('speech_service_base_url', nextSpeechBaseUrl);
    if (nextLegacyRecognitionBaseUrl !== undefined) setSetting('speech_legacy_recognition_base_url', nextLegacyRecognitionBaseUrl);
    if (nextLegacySynthesisBaseUrl !== undefined) setSetting('speech_legacy_synthesis_base_url', nextLegacySynthesisBaseUrl);
    if (body.speechVoice !== undefined) setSetting('speech_voice', body.speechVoice.trim());
    if (body.speechInstruction !== undefined) setSetting('speech_instruction', body.speechInstruction.trim());
    if (body.embeddingModel !== undefined) setSetting('embedding_model', body.embeddingModel.trim());
    if (body.rerankerModel !== undefined) setSetting('reranker_model', body.rerankerModel.trim());
    if (body.apiBaseUrl !== undefined) setSetting('api_base_url', nextBaseUrl);
    if (body.retrievalApiBaseUrl !== undefined) setSetting('retrieval_api_base_url', nextRetrievalBaseUrl);
    if (body.reasoningEffort !== undefined) setSetting('reasoning_effort', body.reasoningEffort);
    if (body.voiceWebSearchEnabled !== undefined) {
      if (typeof body.voiceWebSearchEnabled !== 'boolean') throw Object.assign(new Error('语音联网开关格式不正确。'), {statusCode:400});
      setSetting('voice_web_search_enabled', body.voiceWebSearchEnabled ? '1' : '0');
    }
    if (body.webSearchPolicy !== undefined) setSetting('web_search_policy', body.webSearchPolicy);
    if (body.vaultPath !== undefined) setSetting('vault_path', body.vaultPath.trim());
    if (body.syncDeviceName !== undefined) setSetting('sync_device_name', body.syncDeviceName.trim());
    if (body.syncEnabled !== undefined) setSetting('sync_enabled', body.syncEnabled ? '1' : '0');
    if (body.aiEnabled !== undefined) setSetting('ai_enabled', body.aiEnabled ? '1' : '0');
    return this.current();
  }
}
