import { Children, isValidElement, useEffect, useLayoutEffect, useRef, useState, useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export function AppIconButton({ label, onClick, children, disabled = false }: { label: string; onClick?: () => void; children: ReactNode; disabled?: boolean }) {
  return <button className="icon-button" type="button" aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function FormSelect<T extends string>({ label, value, options, disabled = false, invalid = false, describedBy, onChange }: { label: string; value: T; options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>; disabled?: boolean; invalid?: boolean; describedBy?: string; onChange: (value: T) => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 200, maxHeight: 280 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const selectedIndex = options.findIndex(option => option.value === value);
  const focusOption = (index: number, direction = 1) => {
    for (let step = 0; step < options.length; step++) {
      const next = (index + direction * step + options.length * 2) % options.length;
      if (!options[next].disabled) {
        const option = optionRefs.current[next], menu = menuRef.current;
        option?.focus({ preventScroll: true });
        if (option && menu) {
          if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
          else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
        }
        break;
      }
    }
  };
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(rect.width, window.innerWidth - 24);
    if (menuRef.current) menuRef.current.style.width = `${width}px`;
    const below = window.innerHeight - rect.bottom - 16;
    const above = rect.top - 16;
    const upwards = below < Math.min(280, options.length * 42 + 12) && above > below;
    const maxHeight = Math.max(80, Math.min(320, upwards ? above : below));
    const height = Math.min(maxHeight, menuRef.current?.scrollHeight ?? maxHeight);
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: upwards ? Math.max(12, rect.top - height - 8) : rect.bottom + 8, width, maxHeight });
    focusOption(Math.max(0, selectedIndex));
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); } };
    const scroll = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) setOpen(false); };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div className="form-select" ref={rootRef} onBlur={event => { if (!rootRef.current?.contains(event.relatedTarget as Node) && !menuRef.current?.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button ref={triggerRef} className="form-select-trigger" type="button" aria-label={label} aria-invalid={invalid || undefined} aria-describedby={describedBy} aria-haspopup="listbox" aria-controls={open ? id : undefined} aria-expanded={open} disabled={disabled} onClick={() => setOpen(current => !current)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}><span>{options[selectedIndex]?.label ?? options[0]?.label ?? '暂无选项'}</span><ChevronDown className={open ? 'rotated' : ''} size={16} aria-hidden="true" /></button>
    {open && createPortal(<div ref={menuRef} id={id} className="glass-select-menu" style={position} role="listbox" aria-label={label} onBlur={event => { if (!rootRef.current?.contains(event.relatedTarget as Node) && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>{options.map((option, index) => <button ref={element => { optionRefs.current[index] = element; }} className={option.value === value ? 'active' : ''} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} key={option.value} onClick={() => { onChange(option.value); setOpen(false); triggerRef.current?.focus(); }} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const direction = event.key === 'ArrowDown' ? 1 : -1; focusOption(index + direction, direction); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); focusOption(event.key === 'Home' ? 0 : options.length - 1, event.key === 'Home' ? 1 : -1); }
      else if (event.key === 'Tab') { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) { const match = options.findIndex((item, i) => i > index && item.label.toLowerCase().startsWith(event.key.toLowerCase()) && !item.disabled); if (match >= 0) focusOption(match); }
    }}><span title={option.label}>{option.label}</span>{option.value === value && <Check size={15} aria-hidden="true" />}</button>)}</div>, rootRef.current?.closest('dialog[open]') ?? document.body)}
  </div>;
}

/** Preserve form values and native required validation behind the shared menu. */
export function StyledSelect({ children, onChange, ...props }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> & { onChange?: (event: { target: { value: string } }) => void }) {
  const root = useRef<HTMLSpanElement>(null);
  const [label, setLabel] = useState('选择选项');
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  useEffect(() => { if (props.value) setInvalid(false); }, [props.value]);
  useEffect(() => { const text = root.current?.closest('label')?.textContent; if (text) setLabel(text.split(options[0]?.label ?? '\n')[0].trim() || '选择选项'); });
  const options: Array<{ value: string; label: string; disabled?: boolean }> = [];
  const collect = (nodes: ReactNode) => Children.forEach(nodes, child => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>(child)) return;
    if (child.type === 'option') options.push({ value: String(child.props.value ?? ''), label: Children.toArray(child.props.children).join(''), disabled: child.props.disabled });
    else collect(child.props.children);
  });
  collect(children);
  return <span className="styled-select" ref={root} title={props.title}>
    <select {...props} className="sr-only select-native-value" aria-hidden="true" tabIndex={-1} onChange={event => onChange?.(event)} onInvalid={event => { event.preventDefault(); setInvalid(true); root.current?.querySelector('button')?.focus(); }} >{children}</select>
    <FormSelect label={props['aria-label'] ?? label} value={String(props.value ?? '')} options={options} disabled={props.disabled} invalid={invalid} describedBy={invalid ? errorId : props['aria-describedby']} onChange={value => { setInvalid(false); onChange?.({ target: { value } }); }} />
    {invalid && <span className="select-error" id={errorId} role="alert">请选择一项后继续。</span>}
  </span>;
}
