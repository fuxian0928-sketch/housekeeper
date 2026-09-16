import assert from 'node:assert/strict';
import test from 'node:test';
import { runPlanningPipeline } from './planning-pipeline.js';

const analysisJson = JSON.stringify({
  confirmedFacts: [{ content: '已经完成本地检索', source: '检索方案.md' }], currentStage: '验证阶段', goals: ['验证规划能力'], constraints: [], risks: [], unknowns: ['市场信息'],
  needsExternalResearch: true, researchReasons: ['需要了解市场'], searchQueries: [{ query: 'AI knowledge management market', purpose: '了解市场', timeRange: 'year' }]
});
const reviewJson = JSON.stringify({ factConflicts: [], unsupportedClaims: [], missingRisks: [], missingDependencies: [], staleExternalSources: [], recommendationReasonable: true, requiredChanges: [] });

test('自动策略执行搜索并完成规划复核', async () => {
  const outputs = [analysisJson, '## 推荐方案\n先验证高频场景。', reviewJson];
  const stages: string[] = [];
  let searched = 0;
  const result = await runPlanningPipeline({
    question: '这个产品下一步怎么规划？', localContext: '本地上下文', policy: 'auto',
    complete: async () => outputs.shift() ?? '',
    searchProvider: { searchMany: async () => { searched += 1; return { results: [{ title: '市场报告', url: 'https://example.com', content: '市场摘要', score: 0.8, publishedAt: null, query: 'query', purpose: '了解市场' }], failedQueries: [] }; } },
    onStage: (stage, status) => stages.push(`${stage}:${status}`)
  });
  assert.equal(searched, 1);
  assert.match(result.answer, /先验证高频场景/);
  assert.equal(result.externalResults.length, 1);
  assert.ok(stages.includes('review:done'));
});

test('询问后搜索策略不自动发送外部查询', async () => {
  const outputs = [analysisJson, '本地规划建议', reviewJson];
  let searched = 0;
  const result = await runPlanningPipeline({
    question: '这个产品下一步怎么规划？', localContext: '本地上下文', policy: 'ask',
    complete: async () => outputs.shift() ?? '',
    searchProvider: { searchMany: async () => { searched += 1; return { results: [], failedQueries: [] }; } }
  });
  assert.equal(searched, 0);
  assert.match(result.answer, /当前搜索策略为“询问后搜索”/);
});

