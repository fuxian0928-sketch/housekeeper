import type { ResponsePipelineDependencies } from './native-response-pipeline.js';
import { readVoiceProgress, type VoiceProgressEvent } from '../domain/voice-progress.js';
import { answerDigest, type PlaybackContext } from '../domain/voice-playback-context.js';
import {wantsCameraObservation} from '../domain/interaction/vision-request.js';
import {spokenText} from './spoken-text.js';
import {VOICE_PRESENTATION_VERSION} from '../orchestration/voice-presentation.js';

type TurnSettings = { routingMode: 'life' | 'work' | 'auto'; projectId?: string | null; conversationId?: string | null; voicePrefetchToken?: string; deviceId?: string; voiceChatModel?: string; voiceReasoningEffort?: 'follow' | 'auto' | 'low' | 'medium' | 'high' };
type Options = {
  // Trusted local service only; it owns remote forwarding/authentication.
  baseUrl: string;
  settings(): TurnSettings;
  onConversation(id: string): void;
  onProgress?(event: VoiceProgressEvent): void;
  onNavigation?(request:import('../domain/interaction/navigation-delivery.js').NavigationRequest):void;
  onActivity?(event:{conversationId:string;runId?:string}):void;
  playbackContext?(conversationId: string): PlaybackContext | null;
  onAnswer?(conversationId: string, answerHash: string, assistantMessageId: string): void;
  fetch?: typeof fetch;
  captureCameraFrame?:(signal:AbortSignal)=>Promise<string|null>;
  voicePresentation?:boolean;
};

/** Uses the same /api/chat/stream engine as text chat. No second planner. */
export function createNativeSharedChat(options: Options): ResponsePipelineDependencies['answer'] {
  const root = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(root.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(root.hostname) || root.username || root.password || root.search || root.hash || root.pathname !== '/') throw Error('VOICE_INVALID_LOCAL_SERVICE');
  const endpoint = new URL('/api/chat/stream', root);
  return async function* (context) {
    context.signal.throwIfAborted();
    const settings = options.settings();
    if (!['life', 'work', 'auto'].includes(settings.routingMode)) throw Error('VOICE_INVALID_MODE');
    const projectId = settings.routingMode === 'life' ? null : settings.projectId || null;
    const cameraFrame=wantsCameraObservation(context.text)?await options.captureCameraFrame?.(context.signal).catch(()=>null):null;
    context.signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)(endpoint, {
      method: 'POST', redirect: 'error', signal: context.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: context.text, interactionMode: 'voice', routingMode: settings.routingMode,...(cameraFrame?{cameraFrame}:{}),
        ...(options.voicePresentation?{voicePresentation:VOICE_PRESENTATION_VERSION}:{}),
        agentRuntime:settings.routingMode!=='life',
        ...(settings.voiceChatModel ? { model: settings.voiceChatModel } : {}), ...(settings.voiceReasoningEffort && settings.voiceReasoningEffort !== 'follow' ? { reasoningEffort: settings.voiceReasoningEffort } : {}),
        ...(settings.deviceId ? { deviceId: settings.deviceId } : {}),
        ...(settings.voicePrefetchToken ? { voicePrefetchToken: settings.voicePrefetchToken } : {}),
        projectId, scope: projectId ? 'project' : 'memory', conversationId: settings.conversationId || null,
        ...(settings.conversationId ? {voicePlayback:options.playbackContext?.(settings.conversationId) ?? null} : {}) })
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('VOICE_CHAT_HTTP_FAILED'); }
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '', emitted = '', complete = false, received = 0;
    let startedConversationId: string | undefined;
    let progressTurn: string | undefined, progressSequence = 0;
    let allowProgress=settings.routingMode!=='life';
    function parse(line: string): string {
      if (!line.trim()) return '';
      if (line.length > 262144) throw Error('VOICE_CHAT_EVENT_LIMIT');
      let event;
      try { event = JSON.parse(line); } catch { throw Error('VOICE_CHAT_INVALID_EVENT'); }
      if(event.type==='reasoning-policy'){
        if(['low','medium','high'].includes(event.effort))allowProgress=settings.routingMode!=='life'||event.effort!=='low';
        return '';
      }
      if(event.type==='run-event'&&event.event?.type==='navigation_requested'){
        const navigation=event.event.detail;
        if(typeof navigation?.id==='string'&&typeof navigation?.token==='string'&&['project','document','task','page'].includes(navigation?.target?.kind)){context.signal.throwIfAborted();try{options.onNavigation?.(navigation);}catch{/* Missing UI acknowledgement remains an unconfirmed navigation. */}}
        return '';
      }
      if(event.type==='agent-run'&&typeof event.conversationId==='string'){try{options.onActivity?.({conversationId:event.conversationId,runId:event.runId});}catch{/* Optional UI observer cannot fail speech. */}}
      if (event.type === 'conversation-started') {
        const previousId = settings.conversationId || null;
        const replacedId = event.replacedConversationId;
        if (typeof event.conversationId !== 'string' || !event.conversationId || event.conversationId.length > 200 ||
          (startedConversationId && event.conversationId !== startedConversationId) ||
          (replacedId !== undefined && (!previousId || replacedId !== previousId || event.conversationId === previousId)) ||
          (replacedId === undefined && previousId && event.conversationId !== previousId)) throw Error('VOICE_CHAT_INVALID_CONVERSATION');
        if (!startedConversationId) {
          context.signal.throwIfAborted();
          options.onConversation(event.conversationId);
          startedConversationId = event.conversationId;
        }
        return '';
      }
      if (event.type === 'voice-progress') {
        const safe = readVoiceProgress(event);
        if (safe && allowProgress && (!progressTurn || progressTurn === safe.turnId) && safe.sequence > progressSequence) {
          progressTurn = safe.turnId; progressSequence = safe.sequence;
          context.signal.throwIfAborted();
          context.progress?.();
          try { options.onProgress?.(safe); } catch { /* Optional observer cannot fail the answer. */ }
        }
        return '';
      }
      if (event.type === 'error' || event.type === 'cancelled') throw Error('VOICE_CHAT_FAILED');
      if (event.type === 'delta') {
        if (typeof event.delta !== 'string' || emitted.length + event.delta.length > (options.voicePresentation?30000:3000)) throw Error('VOICE_CHAT_ANSWER_LIMIT');
        emitted += event.delta; return options.voicePresentation?'':event.delta;
      }
      if (event.type === 'done') {
        if (typeof event.answer !== 'string' || !event.answer.startsWith(emitted) || event.answer.length > (options.voicePresentation?30000:3000) || typeof event.conversationId !== 'string' || !event.conversationId || event.conversationId.length > 200) throw Error('VOICE_CHAT_INVALID_COMPLETION');
        if (startedConversationId && event.conversationId !== startedConversationId) throw Error('VOICE_CHAT_INVALID_CONVERSATION');
        if (!startedConversationId && settings.conversationId && event.conversationId !== settings.conversationId) throw Error('VOICE_CHAT_INVALID_CONVERSATION');
        const tail = event.answer.slice(emitted.length);
        const narration=options.voicePresentation&&event.voicePresentation===VOICE_PRESENTATION_VERSION&&typeof event.narration==='string'&&event.narration.trim()&&event.narration.length<=1800?event.narration:undefined;
        let speech=tail,readsOriginal=!options.voicePresentation;
        if(options.voicePresentation){
          const spoken=spokenText(narration??event.answer);
          const explicitReading=/(?:全文|完整|逐字|全部).{0,6}(?:朗读|读出来|念|读一遍)|(?:朗读|念|读出来).{0,6}(?:全文|完整|全部)/.test(context.text);
          // Do not recite a whole report when its summary is missing or invalid.
          const withinLimit=spoken.length<=(explicitReading?1800:300);
          speech=!spoken?'内容已保留在聊天页面，请查看原文。':withinLimit?spoken:'完整内容已保留在页面，口播摘要暂未可靠生成，请查看原文。';
          readsOriginal=!narration&&!!spoken&&withinLimit;
        }
        context.signal.throwIfAborted(); options.onConversation(event.conversationId);
        // A spoken summary is not a receipt that the complete original was read.
        if (readsOriginal && typeof event.assistantMessageId === 'string' && event.assistantMessageId.length > 0 && event.assistantMessageId.length <= 200) {
          try { options.onAnswer?.(event.conversationId,answerDigest(event.answer),event.assistantMessageId); } catch {}
        }
        try{options.onActivity?.({conversationId:event.conversationId,runId:typeof event.runId==='string'?event.runId:undefined});}catch{/* Optional UI observer cannot fail speech. */}
        complete = true;
        return speech;
      }
      // Progress, citations, evidence and plans are never passed to speech synthesis.
      return '';
    }
    try {
      while (!complete) {
        const item = await reader.read(); context.signal.throwIfAborted();
        if (item.done) { buffer += decoder.decode(); if (buffer.trim()) { const text = parse(buffer); if (text) yield text; } break; }
        received += item.value.length;
        if (received > 2000000) throw Error('VOICE_CHAT_STREAM_LIMIT');
        buffer += decoder.decode(item.value, { stream: true });
        let newline;
        while (!complete && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          const text = parse(line); if (text) yield text;
        }
        if (buffer.length > 262144) throw Error('VOICE_CHAT_EVENT_LIMIT');
      }
      if (!complete) throw Error('VOICE_CHAT_TRUNCATED');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
}
