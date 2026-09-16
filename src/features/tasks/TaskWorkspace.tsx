import { DatePicker } from '../../components/DatePicker';
import { useMemo, useRef, useState } from 'react';
import { Check, Circle, Plus, Search, ArrowUpRight, ListTodo, X } from 'lucide-react';
import { api } from '../../api';
import { FormSelect } from '../../components/ui';
import type { Project, Task } from '../../types';
import { dueDay, localDay, matchesTaskView, sortActionTasks, type TaskView } from './task-view';

const views: Array<[TaskView, string]> = [['open', '全部待办'], ['today', '今天到期'], ['overdue', '已逾期'], ['waiting', '等待中'], ['done', '已完成'], ['cancelled', '已取消']];
const statuses = { todo: '未开始', doing: '进行中', waiting: '等待中', done: '已完成', cancelled: '已取消' };

export function TaskWorkspace({ tasks, projects, onRefresh, onOpenProject, onToggle, onError, onEdit }: { tasks: Task[]; projects: Project[]; onRefresh: () => Promise<void>; onOpenProject: (id: string) => void; onToggle: (task: Task) => Promise<void>; onError: (message: string) => void; onEdit: (task: Task) => void }) {
  const [view, setView] = useState<TaskView>('open');
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const [projectId, setProjectId] = useState('all');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [targetProject, setTargetProject] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const today = localDay();
  const projectMap = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  const scoped = tasks.filter(t => (projectId === 'all' || t.projectId === projectId) && `${t.title} ${t.description} ${projectMap.get(t.projectId)?.name ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const visible = sortActionTasks(scoped.filter(t => matchesTaskView(t, view, today)));
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !targetProject || !title.trim()) return;
    setBusy(true);
    try {
      await api.post(`/projects/${encodeURIComponent(targetProject)}/tasks`, { title: title.trim(), dueAt: dueAt || null, priority: 'medium', executor: 'self' });
      setTitle(''); setDueAt(''); setCreating(false); setView('open'); setProjectId('all'); setQuery('');
      await onRefresh();
    } catch (error) { onError(error instanceof Error ? error.message : '任务创建失败，请重试。'); }
    finally { setBusy(false); }
  };
  const toggle = async (task: Task) => {
    if (pending.includes(task.id)) return;
    setPending(current => [...current, task.id]);
    try { await onToggle(task); } finally { setPending(current => current.filter(id => id !== task.id)); }
  };
  return <div className="focus-page">
    <header className="page-header"><div><h1>待办事项</h1><p>把下一步放在眼前，一件一件完成。</p></div><button className="primary-button" onClick={() => { setTargetProject(projectId !== 'all' ? projectId : projects.find(p => p.status === 'active')?.id ?? projects[0]?.id ?? ''); setCreating(true); }}><Plus size={17} />新建待办</button></header>
    {creating && <form className="focus-create" onSubmit={create}><label className="focus-title"><span>要做什么</span><input autoFocus required maxLength={120} value={title} onChange={e => setTitle(e.target.value)} placeholder="写下一个具体的下一步" /></label><div><span>所属项目</span><FormSelect label="待办所属项目" value={targetProject} options={projects.map(p => ({ value: p.id, label: p.name }))} onChange={setTargetProject} /></div><label><span>截止日期</span><DatePicker label="截止日期" value={dueAt} onChange={setDueAt} /></label><div className="form-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => setCreating(false)}>取消</button><button className="primary-button" disabled={busy || !targetProject || !title.trim()}>{busy ? '正在创建…' : '创建待办'}</button></div>{!projects.length && <p>先在项目管理中新建一个项目，再添加待办。</p>}</form>}
    <section className="focus-board">
      <div className="focus-toolbar"><div className="task-search"><Search size={17} aria-hidden="true" /><input ref={searchInput} type="search" aria-label="搜索待办" placeholder="搜索任务或项目" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) setQuery(''); }} /><button className="task-search-clear" type="button" aria-label="清空搜索" disabled={!query} onClick={() => { setQuery(''); searchInput.current?.focus(); }}><X size={15} /></button></div><FormSelect label="筛选所属项目" value={projectId} options={[{ value: 'all', label: '全部项目' }, ...projects.map(p => ({ value: p.id, label: p.name }))]} onChange={setProjectId} /></div>
      <nav className="focus-tabs" aria-label="待办筛选">{views.map(([id, label]) => <button key={id} aria-pressed={view === id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>{label}<span>{scoped.filter(t => matchesTaskView(t, id, today)).length}</span></button>)}</nav>
      <div className="focus-table-heading" aria-hidden="true"><span /><span>任务 / 所属项目</span><span>优先级</span><span>截止日期</span></div>
      <div className="focus-list">{visible.map(task => { const due = dueDay(task.dueAt); const overdue = matchesTaskView(task, 'overdue', today); return <div className={`focus-row ${task.status === 'done' ? 'is-done' : ''}`} key={task.id}>
        <button className="task-check" disabled={pending.includes(task.id)} aria-label={`${task.status === 'done' || task.status === 'cancelled' ? '重新打开' : '完成'}任务：${task.title}`} onClick={() => void toggle(task)}>{task.status === 'done' ? <Check size={18} /> : <Circle size={18} />}</button>
        <div className="focus-task-copy"><button type="button" className="inline-record-link" aria-label={`编辑任务：${task.title}`} disabled={pending.includes(task.id)} onClick={() => onEdit(task)}><strong>{task.title}</strong><span className="record-action-hint">编辑</span></button><div><button className="focus-project-link" onClick={() => onOpenProject(task.projectId)}>{projectMap.get(task.projectId)?.name ?? '查看项目'}<ArrowUpRight size={12} /></button><span>{statuses[task.status]}</span>{task.blockedReason && <span>等待：{task.blockedReason}</span>}</div></div>
        <span className={`priority priority-${task.priority}`}>{task.priority === 'high' ? '高优先' : task.priority === 'medium' ? '中优先' : '低优先'}</span><time className={overdue ? 'due-overdue' : 'focus-due'} dateTime={due ?? undefined}>{due ? `${overdue ? '已逾期 · ' : due === today ? '今天 · ' : ''}${due.slice(5).replace('-', '/')}` : '未设日期'}</time>
      </div>; })}</div>
      {!visible.length && <div className="focus-empty"><ListTodo size={30} /><h2>{query ? '没有找到匹配的待办' : '这里暂时没有任务'}</h2><p>{query ? '试试其他关键词，或切换项目范围。' : '切换筛选查看其他任务，或记下新的下一步。'}</p></div>}
    </section>
  </div>;
}
