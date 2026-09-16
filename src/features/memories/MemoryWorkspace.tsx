import { useCallback, useEffect, useState } from 'react';
import { Brain, FolderKanban, MessageSquare, RefreshCw, UserRound } from 'lucide-react';
import { api } from '../../api';
import type { MemoryOverview, MemoryRecord } from '../../types';

function useMemoryOverview(projectId?: string | null) {
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      setOverview(await api.get<MemoryOverview>(`/memory-overview${query}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '记忆概览读取失败。');
    } finally {
      setLoading(false);
    }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  return { overview, error, loading, load };
}

function OverviewLoading() {
  return <div className="memory-overview-loading"><RefreshCw className="spin" size={18} />正在整理记忆概览…</div>;
}

function OverviewError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="inline-empty"><Brain size={22} /><div><strong>暂时无法读取记忆概览</strong><p>{message}</p><button className="secondary-button" type="button" onClick={onRetry}>重新读取</button></div></div>;
}

export function ProjectMemoryTab({ projectId }: { projectId: string; memories?: MemoryRecord[]; onUpdate?: unknown }) {
  const { overview, error, loading, load } = useMemoryOverview(projectId);
  if (loading && !overview) return <div className="tab-panel project-tab-panel"><OverviewLoading /></div>;
  if (error && !overview) return <div className="tab-panel project-tab-panel"><OverviewError message={error} onRetry={() => { void load(); }} /></div>;
  const project = overview?.projectSummaries[0];
  return <div className="tab-panel project-tab-panel memory-project-overview">
    <div className="section-heading"><div><h3>项目记忆</h3><p>这里只展示 AI 对项目的简短理解，不展开底层记忆。</p></div><span className="memory-count-pill">{project?.memoryCount ?? 0} 条</span></div>
    <article className="memory-summary-row"><FolderKanban size={21} /><div><h4>{project?.projectName ?? '当前项目'}</h4><p>{project?.summary ?? 'AI 还在从这个项目的对话、资料和任务中积累信息。'}</p></div></article>
  </div>;
}

export function MemoryWorkspace({ onOpenChat }: {
  memories?: MemoryRecord[];
  filter?: 'all' | MemoryRecord['status'];
  onFilter?: (filter: 'all' | MemoryRecord['status']) => void;
  onUpdate?: unknown;
  onOpenChat: () => void;
  onRefresh?: () => Promise<void>;
}) {
  const { overview, error, loading, load } = useMemoryOverview();
  return <div className="memory-page memory-overview-page">
    <header className="page-header"><div><h1>记忆</h1><p>AI 会自动记住有用信息；你只需要看整体数量和整理后的概括。</p></div><button className="secondary-button" type="button" onClick={onOpenChat}><MessageSquare size={17} />和记忆对话</button></header>
    {loading && !overview ? <OverviewLoading /> : error && !overview ? <OverviewError message={error} onRetry={() => { void load(); }} /> : overview ? <>
      <section className="memory-total-line"><strong>{overview.totalCount}</strong><div><h2>条记忆已生效</h2><p>需要时自动使用，无需逐条确认。</p></div></section>
      <section className="memory-overview-section"><div className="section-heading"><div><h2>各项目概括</h2></div></div>
        <div className="memory-project-summary-list">{overview.projectSummaries.map((project) => <article className="memory-summary-row" key={project.projectId}><FolderKanban size={20} /><div><div className="memory-summary-title"><h3>{project.projectName}</h3><span>{project.memoryCount} 条</span></div><p>{project.summary}</p></div></article>)}{overview.projectSummaries.length === 0 ? <div className="inline-empty"><FolderKanban size={22} /><div><strong>还没有项目</strong><p>创建项目后，相关对话、资料和任务会自动形成概括。</p></div></div> : null}</div>
      </section>
      <section className="memory-overview-section"><div className="section-heading"><div><h2>关于我</h2><p>AI 对你的偏好、工作方式和长期习惯的整体理解。</p></div><span className="memory-count-pill">{overview.personalSummary.memoryCount} 条</span></div>
        <article className="memory-personal-card"><UserRound size={23} /><p>{overview.personalSummary.summary}</p></article>
      </section>
    </> : null}
  </div>;
}
