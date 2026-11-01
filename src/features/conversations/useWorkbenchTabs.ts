import {createContext, useCallback, useContext, useEffect, useLayoutEffect, useReducer, useRef, useState} from 'react';
import {emptyWorkbenchTabs, workbenchTabsReducer, type WorkbenchTab} from './workbench-tabs';

type DraftState = {dirty: boolean; busy: boolean};
type DraftContext = {active: boolean; report: (key: string, value: DraftState | null) => void};
export const WorkbenchDraftContext = createContext<DraftContext | null>(null);
export function useWorkbenchDraft(key: string, dirty: boolean, busy = false) {
  const context = useContext(WorkbenchDraftContext), report = context?.report;
  useEffect(() => {report?.(key, {dirty, busy}); return () => report?.(key, null);}, [report, key, dirty, busy]);
}
export function useWorkbenchActive() {return useContext(WorkbenchDraftContext)?.active ?? true;}
export function useWorkbenchDraftValue(key: string, value: unknown, editing: boolean, busy = false) {
  const signature = JSON.stringify(value), previousEditing = useRef(false);
  const [baseline, setBaseline] = useState(signature);
  useLayoutEffect(() => {if (!editing || !previousEditing.current) setBaseline(signature); previousEditing.current = editing;}, [editing, signature]);
  useWorkbenchDraft(key, editing && signature !== baseline, busy);
}

export function useWorkbenchTabs() {
  const [state, dispatch] = useReducer(workbenchTabsReducer, {...emptyWorkbenchTabs, tabs: [{id:'transcript',kind:'transcript',title:'聊天'}], activeId:'transcript', recent:['transcript']});
  const [drafts, setDrafts] = useState<Record<string, Record<string, DraftState>>>({});
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState('');
  const open = useCallback((tab: WorkbenchTab, background = false) => dispatch({type: 'open', tab, background}), []);
  const select = useCallback((id: string) => dispatch({type: 'select', id}), []);
  const hide = useCallback(() => dispatch({type: 'hide'}), []);
  const title = useCallback((id: string, value: string) => dispatch({type: 'title', id, title: value}), []);
  const report = useCallback((id: string, key: string, value: DraftState | null) => setDrafts(current => {
    const previous = current[id]?.[key];
    if (value ? previous?.dirty === value.dirty && previous?.busy === value.busy : !previous) return current;
    const section = {...current[id]};
    if (value) section[key] = value; else delete section[key];
    return {...current, [id]: section};
  }), []);
  const isDirty = (id: string) => Object.values(drafts[id] ?? {}).some(value => value.dirty);
  const isBusy = (id: string) => Object.values(drafts[id] ?? {}).some(value => value.busy);
  const close = (id: string) => {
    if (isDirty(id) || isBusy(id)) {setCloseError(''); setClosingId(id); return;}
    dispatch({type: 'close', id});
  };
  const discard = () => {
    if (!closingId) return;
    if (isBusy(closingId)) {setCloseError('页面正在保存或处理，请完成后再关闭。'); return;}
    dispatch({type: 'close', id: closingId}); setClosingId(null); setCloseError('');
  };
  const dirty = state.tabs.some(tab => isDirty(tab.id));
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  return {...state, active: state.tabs.find(tab => tab.id === state.activeId), open, select, hide, title, report, close, isDirty, closing: state.tabs.find(tab => tab.id === closingId), closeError, discard, cancelClose: () => {if (closingId) select(closingId); setClosingId(null); setCloseError('');}};
}
