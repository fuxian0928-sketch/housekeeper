import { AlertTriangle, Check, ChevronRight, Clock3, Database, LoaderCircle, RefreshCw, Search, Sparkles } from 'lucide-react';
import type { DocumentRecord, Project, ProjectSummary, ProjectSummaryVersion, Task } from '../../types';

const formatDateTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

export function OverviewTab({ project, tasks, documents, summary, versions, summaryBusy, canUseAiSummary, onGenerateSummary, onShowTasks, onScan }: { project: Project; tasks: Task[]; documents: DocumentRecord[]; summary: ProjectSummary | null; versions: ProjectSummaryVersion[]; summaryBusy: boolean; canUseAiSummary: boolean; onGenerateSummary: () => void; onShowTasks: () => void; onScan: () => void }) {
  return (
    <div className="tab-panel overview-layout">
      <section className="work-section">
        <div className="section-heading"><div><h3>下一步行动</h3><p>按优先级排列的未完成任务。</p></div><button className="text-button" type="button" onClick={onShowTasks}>查看全部<ChevronRight size={15} /></button></div>
        <div className="task-list compact">
          {tasks.slice(0, 4).map((task) => <article className="task-row" key={task.id}><span className={`task-check ${task.status}`}><Check size={14} /></span><div className="task-copy"><strong>{task.title}</strong><small>{task.priority === 'high' ? '高优先级' : task.priority === 'low' ? '低优先级' : '中优先级'} · {task.status === 'doing' ? '进行中' : task.status === 'waiting' ? '等待中' : '未开始'}</small></div></article>)}
          {tasks.length === 0 ? <div className="inline-empty"><Check size={20} /><div><strong>没有待办任务</strong><p>可以新建任务，或从项目对话中提取。</p></div></div> : null}
        </div>
      </section>
      <section className="work-section knowledge-status">
        <div className="section-heading"><div><h3>关联资料</h3><p>{project.sourcePath || '未关联文件夹；项目对话仍可检索全局资料库'}</p></div><Database size={18} /></div>
        <div className="knowledge-line"><span>{project.sourcePath ? `${documents.length} 篇文档属于当前关联范围` : '全局资料库与项目独立维护'}</span><button className="secondary-button" type="button" onClick={onScan}><RefreshCw size={16} />更新全局资料库</button></div>
      </section>
      <section className="work-section project-summary">
        <div className="section-heading"><div><h3>项目摘要</h3><p>根据当前任务、资料和已确认记忆实时计算。</p></div><button className="secondary-button" type="button" disabled={!canUseAiSummary || summaryBusy} title={canUseAiSummary ? '使用当前模型重新组织项目判断' : '请先在设置中配置并开启大模型'} onClick={onGenerateSummary}>{summaryBusy ? <><LoaderCircle className="spin" size={15} />正在整理…</> : <><Sparkles size={15} />{summary?.mode === 'openai' ? '重新整理' : '大模型整理'}</>}</button></div>
        {summary ? <>
          <p className="summary-narrative">{summary.narrative}</p>
          <div className="summary-grid">
            <div><h4>当前进展</h4><p>{summary.progress}</p></div>
            <div><h4>主要风险</h4><ul>{summary.risks.slice(0, 3).map((risk) => <li key={`${risk.title}-${risk.detail}`}><span className={`risk-mark risk-${risk.severity}`}><AlertTriangle size={13} /></span><div><strong>{risk.title}</strong><p>{risk.detail}</p></div></li>)}</ul></div>
            <div><h4>下一步</h4><ol>{summary.nextActions.map((action) => <li key={`${action.taskId}-${action.title}`}><strong>{action.title}</strong><span>{action.reason}</span></li>)}</ol><button className="text-button" type="button" onClick={onShowTasks}>管理任务<ChevronRight size={14} /></button></div>
          </div>
          {summary.recentChanges?.length || summary.informationGaps?.length ? <div className="summary-insight-grid">
            {summary.recentChanges?.length ? <section className="summary-timeline" aria-labelledby="recent-changes-heading"><div className="summary-detail-heading"><span><Clock3 size={15} /></span><div><h4 id="recent-changes-heading">最近变化</h4><p>项目近期发生的关键动作</p></div></div><ol>{summary.recentChanges.slice(0, 5).map((event) => <li key={`${event.created_at}-${event.title}`}><time dateTime={event.created_at}>{formatDateTime(event.created_at)}</time><div><strong>{event.title}</strong>{event.detail ? <p>{event.detail}</p> : null}</div></li>)}</ol></section> : null}
            {summary.informationGaps?.length ? <section className="summary-gaps" aria-labelledby="information-gaps-heading"><div className="summary-detail-heading"><span><Search size={15} /></span><div><h4 id="information-gaps-heading">信息缺口</h4><p>继续判断前建议补齐的信息</p></div></div><ul>{summary.informationGaps.map((gap, index) => <li key={gap}><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><p>{gap}</p></li>)}</ul></section> : null}
          </div> : null}
          {summary.coverage ? <p className="summary-meta">资料覆盖：{summary.coverage.documentCount} 篇文档 · {summary.coverage.branchCount} 个分支 · 当前依据 {summary.coverage.citedDocumentCount} 篇</p> : null}
          <details className="summary-evidence"><summary>查看判断依据（{summary.evidence.length} 条）</summary><ul>{summary.evidence.map((item, index) => <li key={`${item.type}-${item.source}-${index}`}><span>{item.type === 'document' ? '文档' : item.type === 'memory' ? '记忆' : '任务'}</span><div><strong>{item.title}</strong><small>{item.source}</small></div></li>)}</ul></details>
          <p className="summary-meta">{summary.mode === 'openai' ? `由 ${summary.model} 根据本地事实整理` : '本地规则摘要'} · 更新于 {formatDateTime(summary.generatedAt)}</p>
          {versions.length >= 2 ? <details className="summary-evidence summary-comparison"><summary>比较最近两次总结</summary><div className="summary-grid">
            {versions.slice(0, 2).map((version, index) => <div key={version.id}><h4>{index === 0 ? '最近一次' : '上一次'} · {formatDateTime(version.createdAt)}</h4><strong>{version.summary.headline}</strong><p>{version.summary.progress}</p><small>风险：{version.summary.risks.map((risk) => risk.title).join('、') || '无'}<br />下一步：{version.summary.nextActions.map((action) => action.title).join('、') || '无'}</small></div>)}
          </div></details> : null}
        </> : <div className="history-loading"><LoaderCircle className="spin" size={17} />正在计算项目摘要…</div>}
      </section>
    </div>
  );
}
