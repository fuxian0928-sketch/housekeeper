import {useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent} from 'react';
import {createPortal} from 'react-dom';
import {Check, ChevronDown, Cpu, RefreshCw} from 'lucide-react';
import {api} from '../../api';
import type {AppSettings} from '../../types';

const reasoningOptions = [
  {value: 'auto', label: '自动', description: '自动'},
  {value: 'low', label: '快速', description: '快速思考'},
  {value: 'medium', label: '标准', description: '标准思考'},
  {value: 'high', label: '深入', description: '深入思考'},
] as const;

export function ChatModelSelect({value, onChange, defaultModel, baseUrl, disabled, reasoningEffort, onReasoningEffortChange}: {
  value: string; onChange: (value: string) => void; defaultModel: string; baseUrl: string; disabled: boolean;
  reasoningEffort: AppSettings['reasoningEffort']; onReasoningEffortChange: (value: AppSettings['reasoningEffort']) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const anchorRef = useRef({left: 0, top: 0});
  const id = useId();
  const strengthIndex = Math.max(0, reasoningOptions.findIndex(option => option.value === reasoningEffort));
  const strength = reasoningOptions[strengthIndex];
  const modelOptions = [
    {value: '', label: '跟随默认', detail: defaultModel || '未配置'},
    ...[...new Set([...(value && !models.includes(value) ? [value] : []), ...models])].map(model => ({value: model, label: model, detail: ''})),
  ];
  const selectedIndex = Math.max(0, modelOptions.findIndex(option => option.value === value));
  const modelLabel = value || defaultModel || '未配置模型';

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    setModels([]);
    api.post<{models: string[]}>('/settings/models', {}).then(result => {
      if (active) setModels([...new Set(result.models)]);
    }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [baseUrl, revision]);

  function positionMenu() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || disabled) return;
    const gutter = 12, gap = 7;
    const below = window.innerHeight - rect.bottom - gutter - gap;
    const above = rect.top - gutter - gap;
    const upwards = below < 360 && above > below;
    const width = Math.min(rect.width, window.innerWidth - gutter * 2);
    anchorRef.current = {left: rect.left, top: rect.top};
    setPosition({
      left: Math.max(gutter, Math.min(rect.left, window.innerWidth - width - gutter)),
      width, maxHeight: Math.max(0, Math.min(440, upwards ? above : below)),
      ...(upwards ? {bottom: window.innerHeight - rect.top + gap} : {top: rect.bottom + gap}),
    });
  }
  function toggleMenu() {
    if (open) { setOpen(false); return; }
    positionMenu();
    setOpen(true);
  }
  function closeMenu(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({preventScroll: true});
  }
  function handleBlur(event: FocusEvent) {
    const target = event.relatedTarget as Node | null;
    if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
    closeMenu();
  }
  function chooseStrength(index: number) {
    if (!disabled) onReasoningEffortChange(reasoningOptions[index].value);
  }
  useLayoutEffect(() => {
    if (open) optionRefs.current[selectedIndex]?.focus({preventScroll: true});
  }, [open]);
  useLayoutEffect(() => {
    if (open) positionMenu();
  }, [open, modelLabel]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
    }
    function scroll(event: Event) {
      if (menuRef.current?.contains(event.target as Node)) return;
      const rect = triggerRef.current?.getBoundingClientRect(), anchor = anchorRef.current;
      if (!rect || Math.abs(rect.top - anchor.top) > .5 || Math.abs(rect.left - anchor.left) > .5) setOpen(false);
    }
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return <div className="chat-settings-control" ref={rootRef} onBlur={handleBlur}>
    <button ref={triggerRef} type="button" className="chat-settings-trigger" disabled={disabled}
      aria-label={'模型与思考设置，' + (value ? modelLabel : '跟随默认 · ' + modelLabel) + '，' + strength.description}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      title={(value ? modelLabel : '跟随默认 · ' + modelLabel) + ' · ' + strength.description}
      onClick={toggleMenu} onKeyDown={event => {
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) { event.preventDefault(); toggleMenu(); }
      }}>
      <Cpu size={12} className="chat-settings-icon" aria-hidden="true"/><span className="chat-settings-model">{modelLabel}</span>
      <span className="chat-settings-strength">{strength.label}</span><ChevronDown size={12} className={'chat-settings-chevron' + (open ? ' rotated' : '')} aria-hidden="true"/>
    </button>
    {open && createPortal(<div ref={menuRef} id={id} className="chat-model-menu" style={position} role="dialog" aria-modal="false" aria-label="模型与思考设置" onBlur={handleBlur}>
      <header className="chat-model-menu-heading"><strong id={id + '-models'}>对话模型</strong>
        <button type="button" className="chat-model-reload" disabled={loading || disabled}
          aria-label={error ? '重试读取模型列表' : '刷新模型列表'} title={loading ? '正在读取模型列表' : error ? '读取失败，点击重试' : '刷新模型列表'}
          onClick={() => setRevision(current => current + 1)}><RefreshCw size={13} className={loading ? 'spin' : undefined} aria-hidden="true"/></button>
      </header>
      <div className="chat-model-options" role="radiogroup" aria-labelledby={id + '-models'} aria-busy={loading}>
        {modelOptions.map((option, index) => <button key={option.value} ref={element => { optionRefs.current[index] = element; }}
          type="button" role="radio" aria-checked={option.value === value} tabIndex={index === selectedIndex ? 0 : -1}
          className="chat-model-option" title={option.detail ? option.label + ' · ' + option.detail : option.label} disabled={disabled}
          onClick={() => onChange(option.value)} onKeyDown={event => {
            let next: number;
            if (['ArrowDown', 'ArrowRight'].includes(event.key)) next = (index + 1) % modelOptions.length;
            else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) next = (index + modelOptions.length - 1) % modelOptions.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = modelOptions.length - 1;
            else return;
            event.preventDefault();
            onChange(modelOptions[next].value);
            optionRefs.current[next]?.focus({preventScroll: true});
            optionRefs.current[next]?.scrollIntoView({block: 'nearest'});
          }}>
          <span><span>{option.label}</span>{option.detail ? <small>{option.detail}</small> : null}</span>
          {option.value === value ? <Check size={14} aria-hidden="true"/> : null}
        </button>)}
      </div>
      {error ? <p className="chat-model-menu-note" role="status">列表读取失败，可使用当前模型或点击刷新重试。</p> : loading ? <p className="chat-model-menu-note" role="status">正在读取模型…</p> : null}
      <section className="chat-reasoning-control" aria-labelledby={id + '-reasoning'}>
        <div className="chat-reasoning-heading"><label id={id + '-reasoning'} htmlFor={id + '-range'}>思考强度</label><output htmlFor={id + '-range'}>{strength.description}</output></div>
        <input id={id + '-range'} className="chat-reasoning-slider" type="range" min={0} max={3} step={1} value={strengthIndex}
          aria-valuetext={strength.description} disabled={disabled} style={{'--reasoning-progress': (strengthIndex / 3 * 100) + '%'} as CSSProperties}
          onChange={event => chooseStrength(Number(event.target.value))}/>
        <div className="chat-reasoning-stops">{reasoningOptions.map((option, index) => <button type="button" key={option.value}
          tabIndex={-1} disabled={disabled} aria-pressed={index === strengthIndex} onClick={() => chooseStrength(index)}>{option.label}</button>)}</div>
      </section>
    </div>, rootRef.current?.closest('dialog[open]') ?? document.body)}
  </div>;
}
