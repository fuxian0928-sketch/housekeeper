import type { Task } from '../../types';

export type TaskView = 'open' | 'today' | 'overdue' | 'waiting' | 'done' | 'cancelled';

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dueDay(value: string | null) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : localDay(date);
}

export function matchesTaskView(task: Task, view: TaskView, today = localDay()) {
  const open = task.status !== 'done' && task.status !== 'cancelled';
  const due = dueDay(task.dueAt);
  if (view === 'today') return open && due === today;
  if (view === 'overdue') return open && due !== null && due < today;
  if (view === 'waiting') return open && (task.status === 'waiting' || Boolean(task.blockedReason));
  return view === 'open' ? open : task.status === view;
}

/** Due dates first, then priority; closed tasks show their most recent change first. */
export function sortActionTasks(tasks: Task[]) {
  const rank = { high: 0, medium: 1, low: 2 };
  return [...tasks].sort((a, b) => {
    const aClosed = a.status === 'done' || a.status === 'cancelled';
    const bClosed = b.status === 'done' || b.status === 'cancelled';
    if (aClosed !== bClosed) return Number(aClosed) - Number(bClosed);
    if (aClosed) return b.updatedAt.localeCompare(a.updatedAt);
    return (dueDay(a.dueAt) ?? '9999').localeCompare(dueDay(b.dueAt) ?? '9999')
      || rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt);
  });
}
