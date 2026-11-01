import {FeedbackBanner} from '../../components/FeedbackBanner';
import {useCallback,useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {FileText, FolderKanban, MessageSquare, Network, Orbit, PanelRightClose, Settings, X,Maximize2,Minimize2} from 'lucide-react';
import {WorkbenchDraftContext, type useWorkbenchTabs} from './useWorkbenchTabs';
import type {WorkbenchTab} from './workbench-tabs';
import {WorkbenchSizingContext} from './ResizableWorkbench';
import './workbench-motion.css';

export type WorkbenchTabsModel = ReturnType<typeof useWorkbenchTabs>;
function TabPanel({tab, active, model, panelId, tabId, children, motion, reducedMotion}: {tab: WorkbenchTab; active: boolean; model: WorkbenchTabsModel; panelId: string; tabId: string; children: ReactNode; motion: {enabled: boolean; direction: number}; reducedMotion: boolean}) {
  const panel = useRef<HTMLDivElement>(null), positions = useRef(new Map<HTMLElement, {top: number; left: number}>());
  const [present,setPresent]=useState(active),animationRef=useRef<Animation|null>(null),activeRef=useRef(active);
  activeRef.current=active;
  const motionRef = useRef(motion);motionRef.current=motion;
  const {report} = model;
  const scopedReport = useCallback((key: string, value: {dirty: boolean; busy: boolean} | null) => report(tab.id, key, value), [report, tab.id]);
  const context = useMemo(() => ({active, report: scopedReport}), [active, scopedReport]);
  useLayoutEffect(() => {if (active) for (const [element, position] of positions.current) {if (panel.current?.contains(element)) {element.scrollTop = position.top; element.scrollLeft = position.left;} else positions.current.delete(element);}}, [active]);
  useLayoutEffect(()=>{
    const element=panel.current,options=motionRef.current;
    const previous=animationRef.current;
    const interrupted=previous?.playState==='running';
    const current=interrupted&&element?getComputedStyle(element).transform:null;
    previous?.cancel();animationRef.current=null;
    if(reducedMotion||!options.enabled||!element?.animate){setPresent(active);return;}
    // Keep the outgoing pane painted but inert until it clears the viewport.
    // Reversals start at the current transform; both pages remain opaque.
    if(active)setPresent(true);
    const from=current??(active?`translateX(${options.direction*100}%)`:'translateX(0)');
    const to=active?'translateX(0)':`translateX(${-options.direction*100}%)`;
    const animation=element.animate([{transform:from},{transform:to}],{duration:260,easing:'cubic-bezier(.22,.8,.25,1)',fill:'both'});
    animationRef.current=animation;
    void animation.finished.then(()=>{
      if(animationRef.current!==animation)return;
      animationRef.current=null;
      if(!activeRef.current)setPresent(false);
      animation.cancel();
    },()=>{});
  },[active,reducedMotion]);
  useEffect(()=>()=>{animationRef.current?.cancel();},[]);
  return <div ref={panel} id={panelId} role="tabpanel" aria-labelledby={tabId} aria-hidden={!active} hidden={!active&&!present} inert={!active} tabIndex={active?0:-1} data-active={active} data-exiting={!active&&present} className="workbench-tab-panel" onScrollCapture={event => {if (active && event.target instanceof HTMLElement) positions.current.set(event.target, {top: event.target.scrollTop, left: event.target.scrollLeft});}}>
    <WorkbenchDraftContext.Provider value={context}>{children}</WorkbenchDraftContext.Provider>
  </div>;
}
function CloseDraftDialog({model}: {model: WorkbenchTabsModel}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), bodyId = useId();
  useEffect(() => {const element = dialog.current; if (model.closing) element?.showModal(); return () => element?.close();}, [model.closing?.id]);
  return <dialog ref={dialog} className="workbench-close-dialog" aria-labelledby={titleId} aria-describedby={bodyId} onCancel={event => {event.preventDefault(); model.cancelClose();}}>
    <h2 id={titleId}>关闭“{model.closing?.title}”？</h2><p id={bodyId}>页面中有未保存的修改或正在处理的操作。可以返回处理后再关闭。</p>
    {model.closeError ? <FeedbackBanner tone="error">{model.closeError}</FeedbackBanner> : null}
    <footer><button className="secondary-button" type="button" onClick={model.discard}>放弃修改并关闭</button><button className="primary-button" type="button" autoFocus onClick={model.cancelClose}>继续编辑</button></footer>
  </dialog>;
}
export function WorkbenchTabs({model, render}: {model: WorkbenchTabsModel; render: (tab: WorkbenchTab, active: boolean) => ReactNode}) {
  const sizing=useContext(WorkbenchSizingContext);
  const prefix = useId(), strip = useRef<HTMLDivElement>(null);
  const [reducedMotion,setReducedMotion]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const previousActive=useRef(model.activeId);
  const previousTabs=useRef(model.tabs);
  const priorIndex=previousTabs.current.findIndex(tab=>tab.id===previousActive.current);
  const existingIndex=previousTabs.current.findIndex(tab=>tab.id===model.activeId);
  const nextIndex=existingIndex<0?model.tabs.findIndex(tab=>tab.id===model.activeId):existingIndex;
  const motion={enabled:previousActive.current!==null&&model.activeId!==null&&previousActive.current!==model.activeId,direction:nextIndex<priorIndex?-1:1};
  useEffect(()=>{const preference=window.matchMedia('(prefers-reduced-motion: reduce)');const change=()=>setReducedMotion(preference.matches);preference.addEventListener('change',change);return()=>preference.removeEventListener('change',change);},[]);
  useLayoutEffect(()=>{previousActive.current=model.activeId;previousTabs.current=model.tabs;},[model.activeId,model.tabs]);
  const previousCount = useRef(model.tabs.length);
  useLayoutEffect(() => {const selected=strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');selected?.scrollIntoView({block: 'nearest', inline: 'nearest'});if(model.tabs.length<previousCount.current)selected?.focus({preventScroll:true});previousCount.current=model.tabs.length;}, [model.activeId, model.tabs.length]);
  return <>
    <div className="workbench-tabbar">
      <div ref={strip} className="workbench-tabstrip" role="tablist" aria-label="已打开的页面">
        {model.tabs.map((tab, index) => {
          const active = tab.id === model.activeId, Icon = tab.kind === 'transcript' ? MessageSquare : tab.kind === 'page' ? tab.page === 'settings' ? Settings : tab.page === 'memory-starfield' ? Orbit : tab.page === 'capabilities' ? Network : FolderKanban : FileText;
          return <div className={`workbench-tab${active ? ' active' : ''}`} key={tab.id}>
            <button type="button" role="tab" id={`${prefix}-tab-${index}`} aria-controls={`${prefix}-panel-${index}`} aria-selected={active} tabIndex={active ? 0 : -1} title={tab.title} onClick={() => model.select(tab.id)} onKeyDown={event => {
              let next = index;
              if (event.key === 'ArrowRight') next = (index + 1) % model.tabs.length;
              else if (event.key === 'ArrowLeft') next = (index - 1 + model.tabs.length) % model.tabs.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = model.tabs.length - 1;
              else if (event.key === 'Delete') {event.preventDefault(); model.close(tab.id); return;}
              else return;
              event.preventDefault(); model.select(model.tabs[next].id); strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}><Icon size={13} aria-hidden="true"/><span>{tab.title}</span>{model.isDirty(tab.id) ? <i className="workbench-tab-dirty" aria-label="有未保存修改"/> : tab.attention ? <i className="workbench-tab-attention" aria-label="有新进展"/> : null}</button>
            <button type="button" className="workbench-tab-close" aria-label={`关闭标签：${tab.title}`} title={`关闭${tab.title}`} onClick={() => model.close(tab.id)}><X size={12}/></button>
          </div>;
        })}
      </div>
      {sizing?.canExpand?<button type="button" className="icon-button workbench-tabs-expand" aria-label={sizing.expanded?'还原双栏宽度':'展开详情工作面'} title={sizing.expanded?'还原双栏宽度':'展开详情工作面'} onClick={sizing.toggle}>{sizing.expanded?<Minimize2 size={14}/>:<Maximize2 size={14}/>}</button>:null}
      <button type="button" className="icon-button workbench-tabs-hide" aria-label="收起详情面板" title="收起详情面板" onClick={model.hide}><PanelRightClose size={15}/></button>
    </div>
    <div className="workbench-tab-panels">{model.tabs.map((tab, index) => <TabPanel key={tab.id} tab={tab} model={model} active={tab.id === model.activeId} panelId={`${prefix}-panel-${index}`} tabId={`${prefix}-tab-${index}`} motion={motion} reducedMotion={reducedMotion}>{render(tab, tab.id === model.activeId)}</TabPanel>)}</div>
    <CloseDraftDialog model={model}/>
  </>;
}
