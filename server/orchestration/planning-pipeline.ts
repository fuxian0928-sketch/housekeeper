import { PLANNING_ANALYSIS_INSTRUCTION, PLANNING_DRAFT_INSTRUCTION, PLANNING_REVIEW_INSTRUCTION } from './prompts.js';
import type { TavilyWebSearchProvider, WebSearchQuery, WebSearchResult, WebSearchTimeRange } from '../providers/web-search-provider.js';

export type WebSearchPolicy = 'off' | 'ask' | 'auto';
export type PlanningStage = 'analysis' | 'search' | 'draft' | 'review';

type PlanningAnalysis = {
  confirmedFacts: Array<{ content: string; source: string }>;
  currentStage: string;
  goals: string[];
  constraints: string[];
  risks: string[];
  unknowns: string[];
  needsExternalResearch: boolean;
  researchReasons: string[];
  searchQueries: WebSearchQuery[];
};

type PlanningReview = {
  factConflicts: string[];
  unsupportedClaims: string[];
  missingRisks: string[];
  missingDependencies: string[];
  staleExternalSources: string[];
  recommendationReasonable: boolean;
  requiredChanges: string[];
};

export type PlanningPipelineResult = {
  answer: string;
  externalResults: WebSearchResult[];
  searchNotice: string | null;
  analysis: PlanningAnalysis;
  review: PlanningReview;
};

function jsonObject(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = (fenced ?? text).trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回可识别的结构化结果。');
  return JSON.parse(source.slice(start, end + 1)) as Record<string, unknown>;
}

function strings(value: unknown, limit = 20) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, limit) : [];
}

function normalizeAnalysis(value: Record<string, unknown>): PlanningAnalysis {
  const facts = Array.isArray(value.confirmedFacts) ? value.confirmedFacts : [];
  const queries = Array.isArray(value.searchQueries) ? value.searchQueries : [];
  const allowedTimeRanges = new Set<WebSearchTimeRange>(['day', 'week', 'month', 'year']);
  return {
    confirmedFacts: facts.flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).content === 'string' ? [{ content: String((item as Record<string, unknown>).content).trim(), source: String((item as Record<string, unknown>).source ?? '本地资料').trim() }] : []).filter((item) => item.content).slice(0, 20),
    currentStage: typeof value.currentStage === 'string' ? value.currentStage.trim() : '未能确定',
    goals: strings(value.goals), constraints: strings(value.constraints), risks: strings(value.risks), unknowns: strings(value.unknowns),
    needsExternalResearch: value.needsExternalResearch === true,
    researchReasons: strings(value.researchReasons, 8),
    searchQueries: queries.flatMap((item): WebSearchQuery[] => {
      if (!item || typeof item !== 'object' || typeof (item as Record<string, unknown>).query !== 'string') return [];
      const row = item as Record<string, unknown>;
      const query = String(row.query).replace(/[\r\n\t]/g, ' ').trim().slice(0, 300);
      if (!query) return [];
      const timeRange = typeof row.timeRange === 'string' && allowedTimeRanges.has(row.timeRange as WebSearchTimeRange) ? row.timeRange as WebSearchTimeRange : null;
      return [{ query, purpose: typeof row.purpose === 'string' ? row.purpose.trim().slice(0, 200) : '', timeRange }];
    }).slice(0, 3)
  };
}

function normalizeReview(value: Record<string, unknown>): PlanningReview {
  return {
    factConflicts: strings(value.factConflicts), unsupportedClaims: strings(value.unsupportedClaims), missingRisks: strings(value.missingRisks),
    missingDependencies: strings(value.missingDependencies), staleExternalSources: strings(value.staleExternalSources),
    recommendationReasonable: value.recommendationReasonable !== false, requiredChanges: strings(value.requiredChanges)
  };
}

async function structured<T>(complete: (input: string, instruction: string) => Promise<string>, input: string, instruction: string, normalize: (value: Record<string, unknown>) => T) {
  let raw = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    raw = await complete(attempt === 0 ? input : `${input}\n\n上一次返回无法解析。请严格只返回要求的 JSON 对象。`, instruction);
    try { return normalize(jsonObject(raw)); } catch (error) { if (attempt === 1) throw error; }
  }
  throw new Error('结构化分析失败。');
}

function externalContext(results: WebSearchResult[]) {
  if (!results.length) return '本轮没有可用的外部搜索结果。';
  return results.map((item, index) => `【外部来源 ${index + 1}】${item.title}\nURL：${item.url}${item.publishedAt ? `\n时间：${item.publishedAt}` : ''}\n搜索目的：${item.purpose || '补充外部信息'}\n${item.content}`).join('\n\n');
}

const explicitExternalResearch = /(联网|互联网|网上|外部资料|最新|近期市场|竞品|行业趋势|市场趋势|搜索网络|查一下市场)/;

export async function runPlanningPipeline(input: {
  question: string;
  localContext: string;
  policy: WebSearchPolicy;
  searchProvider?: Pick<TavilyWebSearchProvider, 'searchMany'> | null;
  complete: (input: string, instruction: string) => Promise<string>;
  onStage?: (stage: PlanningStage, status: 'active' | 'done' | 'warning', detail?: string) => void;
  signal?: AbortSignal;
}): Promise<PlanningPipelineResult> {
  input.onStage?.('analysis', 'active');
  const analysis = await structured(input.complete, `用户问题：${input.question}\n\n本地项目上下文：\n${input.localContext}`, PLANNING_ANALYSIS_INSTRUCTION, normalizeAnalysis);
  input.onStage?.('analysis', 'done', `已识别 ${analysis.confirmedFacts.length} 项事实、${analysis.unknowns.length} 项信息缺口`);

  const explicitlyRequested = explicitExternalResearch.test(input.question);
  const shouldSearch = analysis.needsExternalResearch && input.policy === 'auto' || explicitlyRequested && input.policy !== 'off';
  let externalResults: WebSearchResult[] = [];
  let searchNotice: string | null = null;
  if (shouldSearch && input.searchProvider && analysis.searchQueries.length) {
    input.onStage?.('search', 'active', `准备执行 ${analysis.searchQueries.length} 个外部查询`);
    const research = await input.searchProvider.searchMany(analysis.searchQueries, input.signal);
    externalResults = research.results;
    if (research.failedQueries.length) searchNotice = `${research.failedQueries.length} 个查询未能完成，已使用其余结果继续分析。`;
    input.onStage?.('search', externalResults.length ? 'done' : 'warning', externalResults.length ? `获得 ${externalResults.length} 条外部来源` : '没有获得可用的外部来源');
  } else if (shouldSearch && !input.searchProvider) {
    searchNotice = '当前需要外部信息，但尚未配置 Tavily 搜索 Key；本轮仅使用本地资料和模型判断。';
    input.onStage?.('search', 'warning', searchNotice);
  } else if (analysis.needsExternalResearch && input.policy === 'ask') {
    searchNotice = '模型判断外部信息可能影响结论；当前搜索策略为“询问后搜索”，本轮未自动联网。';
    input.onStage?.('search', 'warning', searchNotice);
  } else if (analysis.needsExternalResearch && input.policy === 'off') {
    searchNotice = '模型判断外部信息可能影响结论，但联网搜索已关闭；本轮仅使用本地资料和模型判断。';
    input.onStage?.('search', 'warning', searchNotice);
  } else if (shouldSearch && analysis.searchQueries.length === 0) {
    searchNotice = '模型判断需要外部信息，但没有形成安全、可执行的搜索词；本轮未发送外部查询。';
    input.onStage?.('search', 'warning', searchNotice);
  }

  input.onStage?.('draft', 'active');
  const draft = await input.complete(`用户问题：${input.question}\n\n事实分析：\n${JSON.stringify(analysis)}\n\n本地项目上下文：\n${input.localContext}\n\n外部研究：\n${externalContext(externalResults)}${searchNotice ? `\n\n搜索状态：${searchNotice}` : ''}`, PLANNING_DRAFT_INSTRUCTION);
  input.onStage?.('draft', 'done');

  input.onStage?.('review', 'active');
  const review = await structured(input.complete, `用户问题：${input.question}\n\n事实分析：\n${JSON.stringify(analysis)}\n\n可用外部来源：\n${externalContext(externalResults)}\n\n待复核建议：\n${draft}`, PLANNING_REVIEW_INSTRUCTION, normalizeReview);
  input.onStage?.('review', review.requiredChanges.length || review.factConflicts.length ? 'warning' : 'done', review.requiredChanges.length ? `发现 ${review.requiredChanges.length} 项需要修订` : '建议与现有资料没有明显冲突');

  let answer = draft.trim();
  const changes = [...review.factConflicts, ...review.unsupportedClaims, ...review.missingRisks, ...review.missingDependencies, ...review.requiredChanges];
  if (changes.length) {
    answer = (await input.complete(`请根据复核意见修订回答。保留有价值内容，删除无依据的事实性断言，补足风险与依赖，只输出修订后的最终回答。\n\n用户问题：${input.question}\n\n原回答：\n${draft}\n\n复核意见：\n${changes.map((item) => `- ${item}`).join('\n')}\n\n本地项目上下文：\n${input.localContext}\n\n外部来源：\n${externalContext(externalResults)}`, PLANNING_DRAFT_INSTRUCTION)).trim();
  }
  if (searchNotice) answer += `\n\n> 外部研究提示：${searchNotice}`;
  return { answer, externalResults, searchNotice, analysis, review };
}
