import {createContext,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {clampPaneWidth,COMPACT_WORKBENCH_WIDTH,DEFAULT_PANE_WIDTH,PANE_ENTER_MS,PANE_EXIT_MS,readPaneWidth,WORKBENCH_WIDTH_KEY} from './workbench-layout';
export const WorkbenchSizingContext=createContext<{canExpand:boolean;expanded:boolean;toggle:()=>void}|null>(null);

export function ResizableWorkbench({children,pane,open,keepAlive=false,goldenDefault=false}:{children:ReactNode;pane:ReactNode;open:boolean;keepAlive?:boolean;goldenDefault?:boolean}) {
  const container=useRef<HTMLDivElement>(null);
  const detail=useRef<HTMLElement>(null),lastPane=useRef<ReactNode>(null),returnFocus=useRef<HTMLElement|null>(null);
  const drag=useRef<{pointerId:number;startX:number;startWidth:number}|null>(null);
  const [present,setPresent]=useState(open);
  const [reducedMotion,setReducedMotion]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [preferred,setPreferred]=useState(()=>{try{return goldenDefault&&!window.localStorage.getItem(WORKBENCH_WIDTH_KEY)?0:readPaneWidth(window.localStorage);}catch{return goldenDefault?0:DEFAULT_PANE_WIDTH;}});
  const [containerWidth,setContainerWidth]=useState(()=>window.innerWidth);
  const restoreWidth=useRef(preferred),sizingRef=useRef<{width:number;max:number;resize:(value:number,persist?:boolean)=>void}|null>(null);
  const toggleSize=useCallback(()=>{const current=sizingRef.current;if(!current)return;if(current.width>=current.max-2)current.resize(restoreWidth.current,true);else{restoreWidth.current=current.width;current.resize(current.max,true);}},[]);
  useLayoutEffect(()=>{
    const element=container.current;if(!element)return;
    const update=()=>setContainerWidth(element.getBoundingClientRect().width);
    update();const observer=new ResizeObserver(update);observer.observe(element);
    return()=>observer.disconnect();
  },[]);
  const compact=containerWidth<COMPACT_WORKBENCH_WIDTH;
  const width=clampPaneWidth(preferred||(containerWidth*.381966),containerWidth),max=Math.max(300,containerWidth-370);
  useEffect(()=>{
    const preference=window.matchMedia('(prefers-reduced-motion: reduce)');
    const change=()=>setReducedMotion(preference.matches);
    preference.addEventListener('change',change);return()=>preference.removeEventListener('change',change);
  },[]);
  useLayoutEffect(()=>{
    if(!open)return;
    lastPane.current=pane;
    const active=document.activeElement;
    if(active instanceof HTMLElement&&active!==document.body&&!detail.current?.contains(active))returnFocus.current=active;
  },[open,pane]);
  useLayoutEffect(()=>{
    const element=detail.current;
    if(element){
      // Restore focus before the outgoing pane becomes inert.
      if(!open&&element.contains(document.activeElement)){
        const target=returnFocus.current?.isConnected?returnFocus.current:container.current?.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
        target?.focus({preventScroll:true});
      }
      element.inert=!open;
    }
    if(open){setPresent(true);return;}
    if(reducedMotion){setPresent(false);return;}
    const timer=window.setTimeout(()=>setPresent(false),PANE_EXIT_MS+32);
    return()=>window.clearTimeout(timer);
  },[open,reducedMotion]);
  useEffect(()=>{if(!open&&!present)lastPane.current=null;},[open,present]);
  const save=(value:number)=>{try{window.localStorage.setItem(WORKBENCH_WIDTH_KEY,String(value));}catch{/* Layout still works when storage is unavailable. */}};
  const resize=(value:number,persist=false)=>{const next=clampPaneWidth(value,containerWidth);setPreferred(next);if(persist)save(next);};
  sizingRef.current={width,max,resize};
  const expanded=width>=max-2;
  const sizing=useMemo(()=>({canExpand:!compact,expanded,toggle:toggleSize}),[compact,expanded,toggleSize]);
  return <WorkbenchSizingContext.Provider value={sizing}><div ref={container} className={`workbench-columns resizable-workbench ${open?'pane-open':''}`} data-compact={compact} style={{'--pane-width':`${width}px`,'--pane-duration':`${open?PANE_ENTER_MS:PANE_EXIT_MS}ms`} as CSSProperties}>
    <div className="workbench-main" inert={open&&compact} aria-hidden={open&&compact?true:undefined}>{children}</div>
    <div className="workbench-divider" hidden={compact} aria-hidden={!open||compact} role="separator" aria-label="调整双栏宽度" aria-orientation="vertical" aria-controls="workbench-detail" aria-valuemin={300} aria-valuemax={Math.round(max)} aria-valuenow={width} tabIndex={open&&!compact?0:-1}
      onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);drag.current={pointerId:event.pointerId,startX:event.clientX,startWidth:width};}}
      onPointerMove={event=>{const current=drag.current;if(current?.pointerId===event.pointerId)resize(current.startWidth+current.startX-event.clientX);}}
      onPointerUp={event=>{if(drag.current?.pointerId!==event.pointerId)return;drag.current=null;save(width);event.currentTarget.releasePointerCapture(event.pointerId);}}
      onPointerCancel={()=>{drag.current=null;}}
      onDoubleClick={()=>resize(containerWidth*.381966,true)}
      onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();resize(event.key==='Home'?300:event.key==='End'?max:width+(event.key==='ArrowLeft'?1:-1)*(event.shiftKey?60:20),true);}}
    ><span/></div>
    <section ref={detail} className="workbench-detail" id="workbench-detail" data-present={open||present} aria-hidden={!open}>{keepAlive||open?pane:present?lastPane.current:null}</section>
  </div></WorkbenchSizingContext.Provider>;
}
