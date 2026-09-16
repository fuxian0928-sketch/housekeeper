import { buildProjectOverviewContext } from '../vault.js';
import { database } from '../db.js';
import { buildProjectContext, type KnowledgeCitation } from './context-builder.js';
import { intentContext, type IntentRoute } from './intent-router.js';
import type { EmbeddingProvider } from '../providers/embedding-provider.js';
import type { RerankerProvider } from '../providers/reranker-provider.js';
import { semanticSearch } from '../retrieval/vector-index.js';
import { projectDocumentPriorities } from '../retrieval/project-document-priority.js';

export interface ConversationPlanInput {
  message: string;
  intentRoute: IntentRoute;
  responseGoal?: string;
  retrievalQuery: string;
  projectId: string | null;
  projectName?: string;
  projectSourcePath?: string | null;
  documentPaths: unknown;
  embeddingProvider?: EmbeddingProvider | null;
  rerankerProvider?: RerankerProvider | null;
  signal?: AbortSignal;
}

export interface ConversationPlan {
  intentRoute: IntentRoute;
  contextBlocks: string[];
  citations: KnowledgeCitation[];
  localAnswer: string;
}

export async function runConversationPlan(input: ConversationPlanInput): Promise<ConversationPlan> {
  const intentRoute = input.intentRoute;
  const contextBlocks = [intentContext(intentRoute), `本轮回答目标：${input.responseGoal ?? '准确回应用户的当前请求。'}`];
  if (intentRoute.domain === 'chat' && !intentRoute.requiresRetrieval) return { intentRoute, contextBlocks, citations: [], localAnswer: '我在呢～不过当前大模型暂时不可用，等连接恢复后我们再继续聊。' };
  if (!intentRoute.requiresRetrieval) return { intentRoute, contextBlocks, citations: [], localAnswer: '' };
  if (intentRoute.intents.some(intent => intent.action === 'all_projects_overview')) {
    const projects = database.prepare('SELECT id, name, summary, status FROM projects WHERE deleted_at IS NULL ORDER BY name').all() as Array<{ id: string; name: string; summary: string; status: string }>;
    contextBlocks.push(`项目清单共 ${projects.length} 个。逐个回答目标、已知进展和信息缺口；不要返回空的分类模板，也不要要求用户重新列出名称。`);
    const overviewCitations: KnowledgeCitation[] = [];
    for (const project of projects) {
      const tasks = database.prepare('SELECT title, status FROM tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT 8').all(project.id);
      const memories = database.prepare("SELECT content FROM memories WHERE project_id = ? AND status = 'confirmed' ORDER BY updated_at DESC LIMIT 4").all(project.id);
      const overview = buildProjectOverviewContext(null, project.id);
      const linked = projectDocumentPriorities(project.id).byPath;
      const documents = overview.citations.filter(citation => linked.get(citation.path) === 0).slice(0, 2).map(citation => ({ ...citation, excerpt: citation.excerpt.slice(0, 1600) }));
      overviewCitations.push(...documents);
      contextBlocks.push(`项目：${project.name}\n${JSON.stringify({ summary: project.summary, status: project.status, tasks, memories, documentCount: [...linked.values()].filter(tier => tier === 0).length, documents })}`);
    }
    return { intentRoute, contextBlocks, citations: overviewCitations, localAnswer: projects.length ? projects.map(project => `${project.name}：${project.summary || '目标尚未填写'}（${project.status}）`).join('\n') : '目前项目列表为空。' };
  }
  if (!input.projectId) return { intentRoute, contextBlocks, citations: [], localAnswer: '' };
  const context = await buildProjectContext(input.projectId, input.retrievalQuery, input.projectSourcePath, intentRoute, input.embeddingProvider, input.signal);
  contextBlocks.push(...context.blocks);
  let citations = context.citations;
  const documentPriorities = projectDocumentPriorities(input.projectId).byPath;
  if (input.embeddingProvider) {
    try {
      const dense = await semanticSearch(input.embeddingProvider, input.retrievalQuery, input.projectSourcePath, 30, input.signal, input.projectId);
      const ranked = new Map<string, { citation: KnowledgeCitation; score: number }>();
      citations.forEach((citation, index) => ranked.set(citation.path, { citation, score: 1 / (60 + index + 1) }));
      dense.forEach((citation, index) => {
        const current = ranked.get(citation.path);
        ranked.set(citation.path, { citation: current?.citation ?? citation, score: (current?.score ?? 0) + 1 / (60 + index + 1) });
      });
      citations = [...ranked.values()].sort((a, b) => {
        const tierDifference = (documentPriorities.get(a.citation.path) ?? 2) - (documentPriorities.get(b.citation.path) ?? 2);
        return tierDifference || b.score - a.score;
      }).slice(0, 15).map((item) => item.citation);
      if (input.rerankerProvider && citations.length > 1) {
        const linkedProjectCitations = citations.filter((citation) => (documentPriorities.get(citation.path) ?? 2) === 0);
        const reranked = await input.rerankerProvider.rerank(input.retrievalQuery, citations.map((citation) => `${citation.document}\n${citation.excerpt}`), citations.length, input.signal);
        const accepted = reranked
          .filter((item) => item.score >= 0.2 && citations[item.index])
          .map((item, rerankPosition) => ({ citation: citations[item.index], rerankPosition }))
        const merged = new Map<string, { citation: KnowledgeCitation; rerankPosition: number }>();
        linkedProjectCitations.forEach((citation, index) => merged.set(citation.path, { citation, rerankPosition: index }));
        accepted.forEach((item) => {
          if (!merged.has(item.citation.path)) merged.set(item.citation.path, { citation: item.citation, rerankPosition: linkedProjectCitations.length + item.rerankPosition });
        });
        citations = [...merged.values()]
          .sort((a, b) => {
            const tierDifference = (documentPriorities.get(a.citation.path) ?? 2) - (documentPriorities.get(b.citation.path) ?? 2);
            return tierDifference || a.rerankPosition - b.rerankPosition;
          })
          .slice(0, 10)
          .map((item) => item.citation);
      }
      for (const citation of citations) {
        if (!context.citations.some((item) => item.path === citation.path)) contextBlocks.push(`【语义检索证据】${citation.document}\n来源：${citation.path}\n${citation.excerpt}`);
      }
    } catch {
      // Remote embedding/reranking is optional; the FTS5 + local fallback context remains valid.
    }
  }
  const name = input.projectName || '当前项目';
  const localAnswer = citations.length
    ? `我已结合 ${name} 的文档、记忆、当前与历史任务以及最近变化整理上下文。`
    : `我已读取 ${name} 的任务、记忆和最近变化，但没有找到直接支持当前问题的文档。`;
  return { intentRoute, contextBlocks, citations, localAnswer };
}
