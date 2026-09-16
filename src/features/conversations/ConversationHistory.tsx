import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, History, MessageSquare, MoreHorizontal, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import type { ConversationSummary, Project } from '../../types';

type Props = { projects: Project[]; conversations: ConversationSummary[]; activeConversationId: string | null; busyConversationId: string | null; collapsedGroups: Record<string, boolean>; onToggleGroup: (key: string) => void; onOpen: (id: string) => void; onNew: () => void; onRename: (id: string, title: string) => Promise<void>; onDelete: (id: string) => Promise<void> };
function historyDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

export function ConversationHistory(props: Props) {
  const [query, setQuery] = useState('');
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [menu, setMenu] = useState<{ conversation: ConversationSummary; x: number; y: number } | null>(null);
  const [action, setAction] = useState<{ kind: 'rename' | 'delete'; conversation: ConversationSummary } | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const groups = useMemo(() => {
    const names = new Map(props.projects.map(p => [p.id, p.name]));
    const groups = new Map<string, { key: string; label: string; items: ConversationSummary[] }>();
    props.conversations.filter(c => `${c.title} ${c.projectName ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).forEach(c => {
      const key = c.projectId ?? 'global';
      const group = groups.get(key) ?? { key, label: c.projectId ? c.projectName || names.get(c.projectId) || '未归类项目' : '日常对话', items: [] };
      group.items.push(c); groups.set(key, group);
    });
    return [...groups.values()];
  }, [props.conversations, props.projects, query]);
  const closeMenu = () => { setMenu(null); returnFocus.current?.focus(); };
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', outside); window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [menu]);
  useEffect(() => {
    if (action) { dialogRef.current?.showModal(); if (action.kind === 'rename') dialogRef.current?.querySelector<HTMLInputElement>('input')?.select(); }
  }, [action]);
  const openMenu = (conversation: ConversationSummary, target: HTMLElement, x?: number, y?: number) => {
    returnFocus.current = target;
    const rect = target.getBoundingClientRect();
    setMenu({ conversation, x: Math.max(8, Math.min(x ?? rect.left, window.innerWidth - 204)), y: Math.max(8, Math.min(y ?? rect.bottom + 4, window.innerHeight - 116)) });
  };
  const begin = (kind: 'rename' | 'delete') => {
    if (!menu) return;
    setAction({ kind, conversation: menu.conversation }); setTitle(menu.conversation.title); setError(''); setMenu(null);
  };
  const dismiss = () => { if (!busy) { setAction(null); returnFocus.current?.focus(); } };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!action || busy) return;
    setBusy(true); setError('');
    try {
      if (action.kind === 'rename') await props.onRename(action.conversation.id, title.trim());
      else await props.onDelete(action.conversation.id);
      setAction(null); returnFocus.current?.focus();
    } catch (error) { setError(error instanceof Error ? error.message : '操作失败，请重试。'); }
    finally { setBusy(false); }
  };
  return <div className="conversation-tree refined-history">
    <button className="new-conversation-button" onClick={props.onNew}><Plus size={16} />新建对话</button>
    <button className="mobile-history-toggle" aria-expanded={mobileExpanded} onClick={() => setMobileExpanded(v => !v)}><History size={16} /><span>历史对话</span><small>{props.conversations.length}</small><ChevronDown size={15} /></button>
    <div className="history-list-heading"><span>历史对话</span><small>{props.conversations.length}</small></div>
    <label className="history-search"><Search size={14} /><input aria-label="搜索历史对话" placeholder="搜索对话" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <div className={`conversation-tree-scroll ${mobileExpanded ? 'mobile-expanded' : ''}`}>
      {groups.map(group => <section className="history-group" key={group.key}>
        <button className="history-group-heading" aria-expanded={Boolean(query) || !props.collapsedGroups[group.key]} onClick={() => props.onToggleGroup(group.key)}><ChevronRight className={query || !props.collapsedGroups[group.key] ? 'expanded' : ''} size={13} /><span>{group.label}</span><small>{group.items.length}</small></button>
        {query || !props.collapsedGroups[group.key] ? group.items.map(c => <div key={c.id} className={`history-item ${c.id === props.activeConversationId ? 'selected' : ''}`} onContextMenu={e => { e.preventDefault(); openMenu(c, e.currentTarget.querySelector<HTMLButtonElement>('.history-open')!, e.clientX, e.clientY); }}>
          <button className="history-open" title={c.title} aria-current={c.id === props.activeConversationId ? 'true' : undefined} onClick={() => props.onOpen(c.id)} onKeyDown={e => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openMenu(c, e.currentTarget); } }}><span>{c.title}</span><small><time dateTime={c.updatedAt}>{historyDate(c.updatedAt)}</time><span>{c.messageCount} 条消息{c.compressedAt ? ' · 已压缩' : ''}</span></small></button>
          <button className="history-more" aria-label={`管理对话：${c.title}`} aria-haspopup="menu" aria-expanded={menu?.conversation.id === c.id} onClick={e => openMenu(c, e.currentTarget)}><MoreHorizontal size={16} /></button>
        </div>) : null}
      </section>)}
      {!groups.length && <div className="conversation-tree-empty"><MessageSquare size={22} /><strong>{query ? '没有匹配的对话' : '还没有历史对话'}</strong><span>{query ? '试试其他关键词。' : '和小E聊聊今天吧。'}</span></div>}
    </div>
    {menu && createPortal(<div className="history-context-menu" ref={menuRef} role="menu" aria-label="对话操作" style={{ left: menu.x, top: menu.y }} onKeyDown={e => {
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
      else if (e.key === 'Tab') setMenu(null);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    }}><button role="menuitem" onClick={() => begin('rename')}><Pencil size={15} />重命名</button><button role="menuitem" className="history-delete" disabled={props.busyConversationId === menu.conversation.id} title={props.busyConversationId === menu.conversation.id ? '请先停止当前回答' : undefined} onClick={() => begin('delete')}><Trash2 size={15} />删除对话</button></div>, document.body)}
    {action && createPortal(<dialog ref={dialogRef} className="history-action-dialog" onCancel={e => { e.preventDefault(); dismiss(); }} aria-labelledby="history-action-title"><form onSubmit={submit}>
      <header><h2 id="history-action-title">{action.kind === 'rename' ? '重命名对话' : '删除这段对话？'}</h2><button type="button" className="icon-button" aria-label="关闭" disabled={busy} onClick={dismiss}><X size={18} /></button></header>
      {action.kind === 'rename' ? <label><span>对话名称</span><input required maxLength={120} disabled={busy} value={title} onChange={e => setTitle(e.target.value)} /></label> : <p>“{action.conversation.title}”及其消息将被永久删除。项目、资料与已保存的记忆会保留。</p>}
      {error && <p className="history-action-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary-button" disabled={busy} onClick={dismiss}>取消</button><button className={action.kind === 'delete' ? 'history-confirm-delete' : 'primary-button'} disabled={busy || (action.kind === 'rename' && !title.trim())}>{busy ? '处理中…' : action.kind === 'rename' ? '保存名称' : '删除对话'}</button></footer>
    </form></dialog>, document.body)}
  </div>;
}
