export type WorkbenchPage = 'tasks' | 'home' | 'projects' | 'knowledge' | 'memory' | 'memory-starfield' | 'capabilities' | 'trash' | 'settings';
export type DocumentEvidence = {parentId: string; sourceRevision?: string};
export type WorkbenchTab = ({kind: 'transcript' | 'results'} | {kind: 'page'; page: WorkbenchPage} | {kind: 'document'; documentId: string; version?: number; evidence?: DocumentEvidence}) & {id: string; title: string; attention?: boolean};
export type WorkbenchTabsState = {tabs: WorkbenchTab[]; activeId: string | null; recent: string[]};
export const emptyWorkbenchTabs: WorkbenchTabsState = {tabs: [], activeId: null, recent: []};
export type WorkbenchTabsAction =
  | {type: 'open'; tab: WorkbenchTab; background?: boolean}
  | {type: 'select'; id: string}
  | {type: 'close'; id: string}
  | {type: 'hide'}
  | {type: 'title'; id: string; title: string};

export function workbenchTabsReducer(state: WorkbenchTabsState, action: WorkbenchTabsAction): WorkbenchTabsState {
  if (action.type === 'hide') return state.activeId === null ? state : {...state, activeId: null};
  if (action.type === 'title') return state.tabs.some(tab => tab.id === action.id && tab.title !== action.title)
    ? {...state, tabs: state.tabs.map(tab => tab.id === action.id ? {...tab, title: action.title} : tab)} : state;
  if (action.type === 'close') {
    const tabs = state.tabs.filter(tab => tab.id !== action.id);
    if (tabs.length === state.tabs.length) return state;
    const recent = state.recent.filter(id => id !== action.id);
    const activeId = state.activeId === action.id ? recent.find(id => tabs.some(tab => tab.id === id)) ?? tabs.at(-1)?.id ?? null : state.activeId;
    return {tabs: tabs.map(tab => tab.id === activeId ? {...tab, attention: false} : tab), activeId, recent};
  }
  if (action.type === 'select' && !state.tabs.some(tab => tab.id === action.id)) return state;
  const id = action.type === 'select' ? action.id : action.tab.id;
  const existing = state.tabs.find(tab => tab.id === id);
  const activate = action.type === 'select' || !action.background;
  const attention = !activate && state.activeId !== id && (action.type === 'open' && action.tab.attention || existing?.attention);
  const tabs = action.type === 'open' && !existing ? [...state.tabs, {...action.tab, attention: Boolean(attention)}]
    : state.tabs.map(tab => tab.id === id ? {...tab, attention: Boolean(attention)} : tab);
  return {tabs, activeId: activate ? id : state.activeId, recent: activate ? [id, ...state.recent.filter(item => item !== id)] : state.recent};
}

export const workbenchPageTitles: Record<WorkbenchPage, string> = {home: '项目总览', projects: '项目管理', tasks: '待办事项', knowledge: '知识与文档', memory: '长期记忆', 'memory-starfield': '记忆星空', capabilities: '能力中心', trash: '项目回收站', settings: '设置'};
export function documentTabId(documentId: string, version?: number, evidence?: DocumentEvidence) {
  return JSON.stringify(['document', documentId, version ?? null, evidence?.parentId ?? null, evidence?.sourceRevision ?? null]);
}
