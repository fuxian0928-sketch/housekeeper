import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function parseDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return dateKey(date) === value ? date : null;
}

/** Date-only values stay in local calendar time; no UTC conversion. */
export function DatePicker({ value, onChange, label = '选择日期', disabled = false }: { value: string; onChange: (value: string) => void; label?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => parseDate(value) ?? new Date());
  const [position, setPosition] = useState({ left: 0, top: 0, width: 300, maxHeight: 390 });
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const days = useRef(new Map<string, HTMLButtonElement>());
  const id = useId();
  const today = dateKey(new Date());
  const selected = parseDate(value);
  const cursorKey = dateKey(cursor);
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - (first.getDay() + 6) % 7);
  const dates = Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const choose = (next: string) => { onChange(next); close(); };
  const moveMonth = (offset: number) => setCursor(current => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(Math.max(300, rect.width), window.innerWidth - 24);
    const height = Math.min(390, window.innerHeight - 24);
    const above = window.innerHeight - rect.bottom < height + 8 && rect.top > window.innerHeight - rect.bottom;
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: Math.max(12, Math.min(above ? rect.top - height - 8 : rect.bottom + 8, window.innerHeight - height - 12)), width, maxHeight: height });
  }, [open]);
  useLayoutEffect(() => { if (open) days.current.get(cursorKey)?.focus({ preventScroll: true }); }, [open, cursorKey]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) setOpen(false); };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <span className="date-picker">
    <button type="button" ref={trigger} className="date-picker-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => { if (!open) setCursor(parseDate(value) ?? new Date()); setOpen(current => !current); }}><span className={selected ? '' : 'date-placeholder'}>{selected ? `${selected.getFullYear()} / ${String(selected.getMonth() + 1).padStart(2, '0')} / ${String(selected.getDate()).padStart(2, '0')}` : '选择日期'}</span><CalendarDays size={17} aria-hidden="true" /></button>
    {open && createPortal(<div ref={popup} id={id} className="glass-calendar" role="dialog" aria-label={`${label}日历`} style={position} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) setOpen(false); }}>
      <div className="calendar-heading">
        <button type="button" aria-label="上一年" onClick={() => moveMonth(-12)}><ChevronsLeft size={16} /></button>
        <button type="button" aria-label="上个月" onClick={() => moveMonth(-1)}><ChevronLeft size={16} /></button>
        <strong aria-live="polite">{cursor.getFullYear()}年{cursor.getMonth() + 1}月</strong>
        <button type="button" aria-label="下个月" onClick={() => moveMonth(1)}><ChevronRight size={16} /></button>
        <button type="button" aria-label="下一年" onClick={() => moveMonth(12)}><ChevronsRight size={16} /></button>
      </div>
      <div className="calendar-weekdays" aria-hidden="true">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
      <div className="calendar-days" role="group" aria-label="日期">
        {dates.map(date => { const key = dateKey(date); return <button key={key} ref={element => { if (element) days.current.set(key, element); else days.current.delete(key); }} type="button" tabIndex={key === cursorKey ? 0 : -1} className={`${date.getMonth() !== cursor.getMonth() ? 'other-month' : ''} ${key === value ? 'selected' : ''}`} aria-label={key} aria-pressed={key === value} aria-current={key === today ? 'date' : undefined} onClick={() => choose(key)} onKeyDown={event => {
          const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key];
          if (offset !== undefined) { event.preventDefault(); setCursor(new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset)); }
          else if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); moveMonth((event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1)); }
          else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); const weekday = (date.getDay() + 6) % 7; setCursor(new Date(date.getFullYear(), date.getMonth(), date.getDate() + (event.key === 'Home' ? -weekday : 6 - weekday))); }
        }}>{date.getDate()}</button>; })}
      </div>
      <div className="calendar-footer"><button type="button" onClick={() => choose('')}>清除日期</button><button type="button" onClick={() => choose(today)}>今天</button></div>
    </div>, trigger.current?.closest('dialog[open]') ?? document.body)}
  </span>;
}
