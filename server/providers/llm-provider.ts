import { modelReasoning } from './model-reasoning.js';
export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high';

export interface LlmCompletionOptions {
  instruction: string;
  maxTokens?: number | null;
  reasoningEffort?: ReasoningEffort;
  enableThinking?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LlmProvider {
  readonly model: string;
  complete(input: string, options: LlmCompletionOptions): Promise<string>;
  stream(input: string, onDelta: (delta: string) => void, options: LlmCompletionOptions): Promise<string>;
}

function outputText(payload: Record<string, unknown>) {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : null;
  const message = first?.message && typeof first.message === 'object' ? first.message as Record<string, unknown> : null;
  if (typeof message?.content === 'string') return message.content.trim();
  if (Array.isArray(message?.content)) return message.content.flatMap((part) => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string' ? [String((part as Record<string, unknown>).text)] : []).join('\n').trim();
  return '';
}

function finalAnswer(text: string, finishReason?: string) {
  const leakedEndToken = /<\|(?:eos|endoftext|im_end)\|>/i.test(text);
  const cleaned = text.replace(/<\|(?:eos|endoftext|im_end)\|>/gi, '').trim();
  if (finishReason === 'length') return `${cleaned}\n\n> 回答已达到当前接口的输出长度上限，内容可能不完整。你可以提高“最大 Token”，或回复“继续回答”。`;
  if (leakedEndToken) return `${cleaned}\n\n> 模型提前返回了结束标记，本次回答可能不完整。你可以回复“继续回答”。`;
  return cleaned;
}

export class OpenAICompatibleLlmProvider implements LlmProvider {
  constructor(public readonly model: string, private readonly baseUrl: string, private readonly apiKey: string) {}

  private requestBody(input: string, options: LlmCompletionOptions, stream: boolean) {
    const body: Record<string, unknown> = { model: this.model, messages: [{ role: 'system', content: options.instruction }, { role: 'user', content: input }], stream };
    if (options.maxTokens) body.max_tokens = options.maxTokens;
    Object.assign(body,modelReasoning(this.model,this.baseUrl,options.reasoningEffort,options.enableThinking));
    return body;
  }

  async complete(input: string, options: LlmCompletionOptions) {
    const result = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(this.requestBody(input, options, false)),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 600000)]) : AbortSignal.timeout(options.timeoutMs ?? 600000)
    });
    const payload = await result.json().catch(() => ({})) as Record<string, unknown>;
    if (!result.ok) {
      const apiError = payload.error && typeof payload.error === 'object' ? String((payload.error as Record<string, unknown>).message ?? '') : '';
      throw new Error(apiError || `模型服务返回了 ${result.status}。`);
    }
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const first = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : null;
    const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason : undefined;
    const text = finalAnswer(outputText(payload), finishReason);
    if (!text) throw new Error('模型没有返回可显示的文字。');
    return text;
  }

  async completeWithImage(input: string, imageDataUrl: string, options: LlmCompletionOptions) {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: options.instruction },
        { role: 'user', content: [{ type: 'text', text: input }, { type: 'image_url', image_url: { url: imageDataUrl } }] }
      ],
      stream: false
    };
    if (options.maxTokens) body.max_tokens = options.maxTokens;
    Object.assign(body,modelReasoning(this.model,this.baseUrl,options.reasoningEffort,options.enableThinking));
    const result = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 120000)]) : AbortSignal.timeout(options.timeoutMs ?? 120000)
    });
    const payload = await result.json().catch(() => ({})) as Record<string, unknown>;
    if (!result.ok) {
      const apiError = payload.error && typeof payload.error === 'object' ? String((payload.error as Record<string, unknown>).message ?? '') : '';
      throw new Error(apiError || `视觉模型服务返回了 ${result.status}。`);
    }
    const text = finalAnswer(outputText(payload));
    if (!text) throw new Error('视觉模型没有返回可用的画面描述。');
    return text;
  }

  async stream(input: string, onDelta: (delta: string) => void, options: LlmCompletionOptions) {
    const firstTokenController = new AbortController();
    let firstTokenTimer = setTimeout(() => firstTokenController.abort(new Error('模型长时间没有返回内容。')), 180000);
    const activity=()=>{clearTimeout(firstTokenTimer);firstTokenTimer=setTimeout(()=>firstTokenController.abort(new Error('模型数据流长时间没有继续返回。')),180000);};
    const signals = [firstTokenController.signal, AbortSignal.timeout(options.timeoutMs ?? 600000), ...(options.signal ? [options.signal] : [])];
    try {
      const result = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.requestBody(input, options, true)), signal: AbortSignal.any(signals)
      });
      if (!result.ok) {
        const payload = await result.json().catch(() => ({})) as Record<string, unknown>;
        const apiError = payload.error && typeof payload.error === 'object' ? String((payload.error as Record<string, unknown>).message ?? '') : '';
        throw new Error(apiError || `模型服务返回了 ${result.status}。`);
      }
      if (!result.body) throw new Error('模型服务没有返回可读取的数据流。');
      const reader = result.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let answer = '';
      let finishReason: string | undefined;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const raw = line.trim().replace(/^data:\s*/, '');
          if (!raw || raw === '[DONE]' || raw.startsWith(':')) continue;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
          const choices = Array.isArray(payload.choices) ? payload.choices : [];
          const first = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : null;
          if (typeof first?.finish_reason === 'string') finishReason = first.finish_reason;
          const delta = first?.delta && typeof first.delta === 'object' ? first.delta as Record<string, unknown> : null;
          // Thinking is transport activity, never display or speak its raw text.
          if(typeof delta?.reasoning_content==='string'&&delta.reasoning_content)activity();
          const content = typeof delta?.content === 'string' ? delta.content : '';
          if (!content) continue;
          activity();
          answer += content;
          onDelta(content);
        }
      }
      if (!answer.trim()) throw new Error('模型没有返回可显示的回答。');
      return finalAnswer(answer, finishReason);
    } finally { clearTimeout(firstTokenTimer); }
  }
}
