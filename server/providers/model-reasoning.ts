import type { ReasoningEffort } from './llm-provider.js';

export function isDeepSeek(model: string, baseUrl: string) {
  let official=false;try{official=new URL(baseUrl).hostname==='api.deepseek.com';}catch{/* URL validation belongs to the connection. */}
  return official || /(?:^|[/_:-])deepseek(?:[-/_:]|$)/i.test(model);
}

/** Translate app semantics into provider parameters in one place. */
export function modelReasoning(model: string, baseUrl: string, effort: ReasoningEffort = 'auto', enabled?: boolean): Record<string, unknown> {
  const thinking=enabled??(effort==='auto'?undefined:effort!=='low');
  if(isDeepSeek(model,baseUrl)){
    // Official current API defaults to thinking=enabled. Always make our choice
    // explicit so "quick" cannot accidentally inherit that slow default.
    return {thinking:{type:thinking===false||thinking===undefined?'disabled':'enabled'},...(thinking===true?{reasoning_effort:effort==='high'?'high':'low'}:{})};
  }
  if(/(?:^|[/_:-])qwen/i.test(model))return {...(thinking===undefined?{}:{enable_thinking:thinking}),...(thinking===true&&effort!=='auto'?{reasoning_effort:effort}:{})};
  return effort==='auto'?{}:{reasoning_effort:effort};
}
