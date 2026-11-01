import {useCallback,useDeferredValue,useEffect,useId,useMemo,useRef,useState} from 'react';
import {ArrowDownUp,ArrowUpRight,ChevronRight,Compass,FileText,Focus,List,LoaderCircle,Orbit,Search,X,ZoomIn,ZoomOut} from 'lucide-react';
import {api} from '../../api';
import {useWorkbenchActive} from '../conversations/useWorkbenchTabs';
import {ambientStars,layoutStarfield,placeStarLabels,type StarGraph,type StarNode} from './starfield-model';
import './memory-starfield.css';

const preview=import.meta.env.DEV&&import.meta.env.VITE_MEMORY_STARFIELD_DEMO==='1';
const nodeName=(node: StarNode)=>node.kind==='group'?'星群':node.kind==='event'?'事件':node.state==='historical'?'历史记忆':'当前记忆';
const time=(value: string)=>value&&!Number.isNaN(Date.parse(value))?new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'时间未记录';
const short=(value: string,length=17)=>value.length>length?value.slice(0,length)+'…':value;
const starShape=(radius: number)=>{const tip=radius*1.55,bend=tip*.22;return `M 0 ${-tip} Q ${bend} ${-bend} ${tip} 0 Q ${bend} ${bend} 0 ${tip} Q ${-bend} ${bend} ${-tip} 0 Q ${-bend} ${-bend} 0 ${-tip} Z`;};

export default function MemoryStarfield({onOpenDocument,onOpenChat}: {onOpenDocument: (id: string)=>void;onOpenChat: ()=>void}) {
  const active=useWorkbenchActive(),prefix=useId().replaceAll(':',''),canvas=useRef<HTMLDivElement>(null),svg=useRef<SVGSVGElement>(null);
  const [graph,setGraph]=useState<StarGraph|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [query,setQuery]=useState(''),[showDirectory,setShowDirectory]=useState(false);
  const [selected,setSelected]=useState<string|null>(null),[hovered,setHovered]=useState<string|null>(null),[retry,setRetry]=useState(0),[demoBusy,setDemoBusy]=useState(false);
  const [size,setSize]=useState({width:900,height:620}),[view,setView]=useState({x:0,y:0,scale:1}),[flying,setFlying]=useState(false);
  const drag=useRef<{id:number;x:number;y:number;originX:number;originY:number}|null>(null),controller=useRef<AbortController|null>(null);
  const deferredQuery=useDeferredValue(query);
  useEffect(()=>{if(!active){setSelected(null);setHovered(null);setShowDirectory(false);setFlying(false);setView({x:0,y:0,scale:1});}},[active]);
  const load=useCallback(async(signal: AbortSignal)=>{
    const params=new URLSearchParams({limit:'100',history:'1'});if(deferredQuery.trim())params.set('q',deferredQuery.trim());
    setBusy(true);
    try {
      const next=await api.get<StarGraph>(`/memory-graph?${params}`,{signal});
      if(signal.aborted)return;
      setGraph(current=>current?.revision===next.revision?current:next);setError('');
    } catch(failure){if(!signal.aborted)setError(failure instanceof Error?failure.message:'暂时无法读取记忆，请稍后重试。');}
    finally{if(!signal.aborted)setBusy(false);}
  },[deferredQuery]);
  useEffect(()=>{
    if(!active)return;
    const refresh=()=>{if(document.hidden)return;controller.current?.abort();const pending=new AbortController();controller.current=pending;void load(pending.signal);};
    const delayed=setTimeout(refresh,deferredQuery?220:0),poll=setInterval(refresh,10000);
    document.addEventListener('visibilitychange',refresh);window.addEventListener('focus',refresh);
    return()=>{clearTimeout(delayed);clearInterval(poll);controller.current?.abort();document.removeEventListener('visibilitychange',refresh);window.removeEventListener('focus',refresh);};
  },[active,load,retry,deferredQuery]);
  useEffect(()=>{setSelected(null);setGraph(null);},[deferredQuery]);
  useEffect(()=>{
    const element=canvas.current;if(!element)return;
    const observer=new ResizeObserver(([entry])=>{const {width,height}=entry.contentRect;if(width>0&&height>0)setSize({width,height});});observer.observe(element);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    const element=svg.current;if(!element)return;
    const wheel=(event: WheelEvent)=>{event.preventDefault();setFlying(false);const bounds=element.getBoundingClientRect(),x=event.clientX-bounds.left-size.width/2,y=event.clientY-bounds.top-size.height/2;setView(v=>{const scale=Math.max(.45,Math.min(2.8,v.scale*Math.exp(-event.deltaY*.0012))),ratio=scale/v.scale;return{x:x-(x-v.x)*ratio,y:y-(y-v.y)*ratio,scale};});};
    element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);
  },[size.width,size.height]);
  const points=useMemo(()=>graph?layoutStarfield(graph,size.width,size.height):new Map(),[graph,size.width,size.height]);
  const stars=useMemo(()=>ambientStars(size.width,size.height),[size.width,size.height]);
  const defaultLabels=useMemo(()=>{
    return new Set((graph?.nodes??[]).filter(node=>node.kind==='group').map(node=>node.id));
  },[graph]);
  const selectedNode=graph?.nodes.find(n=>n.id===selected)??null,spotlight=hovered??selectedNode?.id??null;
  const hoveredNode=!selectedNode?graph?.nodes.find(node=>node.id===hovered):null,hoveredPoint=hoveredNode?points.get(hoveredNode.id):null;
  const labels=useMemo(()=>placeStarLabels(graph?.nodes??[],points,defaultLabels,spotlight),[graph,points,defaultLabels,spotlight]);
  const neighbors=useMemo(()=>{
    const ids=new Set<string>();if(!spotlight||!graph)return ids;ids.add(spotlight);
    for(const edge of graph.edges)if(edge.source===spotlight)ids.add(edge.target);else if(edge.target===spotlight)ids.add(edge.source);
    return ids;
  },[graph,spotlight]);
  const related=selectedNode&&graph?graph.edges.filter(e=>e.source===selectedNode.id||e.target===selectedNode.id).map(edge=>({edge,node:graph.nodes.find(n=>n.id===(edge.source===selectedNode.id?edge.target:edge.source))!})).filter(item=>item.node):[];
  const zoom=(delta: number)=>setView(v=>({...v,scale:Math.max(.45,Math.min(2.8,v.scale+delta))}));
  const choose=(id: string)=>{
    setSelected(id);setShowDirectory(false);setHovered(null);
    const point=points.get(id);if(!point)return;
    const narrow=size.width<=620,targetX=narrow?size.width*.5:Math.max(110,(size.width-310)/2),targetY=size.height*(narrow?.22:.5);
    setFlying(true);setView(current=>({...current,x:targetX-size.width/2-point.x*current.scale,y:targetY-size.height/2-point.y*current.scale}));
  };
  const dismiss=()=>{setSelected(null);setHovered(null);setFlying(true);setView({x:0,y:0,scale:1});};
  async function demoChange(){setDemoBusy(true);try{const response=await fetch('/__memory-demo/advance',{method:'POST'});if(!response.ok)throw Error('演示未能更新，请重试。');setRetry(v=>v+1);}catch(failure){setError(failure instanceof Error?failure.message:'演示未能更新。');}finally{setDemoBusy(false);}}
  return <section className="memory-starfield" aria-label="记忆星空" aria-busy={busy} data-active={active}>
    <header className="starfield-heading"><div><h2>记忆星空<span className="starfield-live"><i/>{error?'更新暂停':busy?'同步中':'自动更新'}</span></h2><p>每一次经历，都有迹可循。</p></div><div className="starfield-count"><strong>{graph?.stats.memories??'—'}</strong><span>条当前记忆</span></div></header>
    <div className="starfield-toolbar">
      <label className="starfield-search"><Search size={14}/><input aria-label="搜索记忆与事件" placeholder="寻找一段记忆、一件事…" value={query} onChange={e=>setQuery(e.target.value)} maxLength={120}/>{query?<button type="button" aria-label="清除搜索" onClick={()=>setQuery('')}><X size={12}/></button>:null}</label>
    </div>
    <div className="starfield-canvas" ref={canvas}>
      <svg ref={svg} className="starfield-map" role="group" aria-label="可缩放拖动的记忆关系图" tabIndex={0} onKeyDown={event=>{
        if(event.target!==event.currentTarget)return;
        if(event.key==='Escape'){setSelected(null);setShowDirectory(false);}
        else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();setView(v=>({...v,x:v.x+(event.key==='ArrowLeft'?35:event.key==='ArrowRight'?-35:0),y:v.y+(event.key==='ArrowUp'?35:event.key==='ArrowDown'?-35:0)}));}
        else if(event.key==='+'||event.key==='=')zoom(.15);else if(event.key==='-')zoom(-.15);
      }} onPointerDown={event=>{if(event.button!==0)return;setFlying(false);drag.current={id:event.pointerId,x:event.clientX,y:event.clientY,originX:view.x,originY:view.y};event.currentTarget.setPointerCapture(event.pointerId);event.currentTarget.dataset.dragging='true';}}
      onPointerMove={event=>{const d=drag.current;if(d?.id===event.pointerId)setView(v=>({...v,x:d.originX+event.clientX-d.x,y:d.originY+event.clientY-d.y}));}}
      onPointerUp={event=>{if(drag.current?.id===event.pointerId){const d=drag.current;if(Math.hypot(event.clientX-d.x,event.clientY-d.y)<4)setSelected(null);drag.current=null;delete event.currentTarget.dataset.dragging;event.currentTarget.releasePointerCapture(event.pointerId);}}}
      onPointerCancel={event=>{drag.current=null;delete event.currentTarget.dataset.dragging;}}>
        <defs>
          <radialGradient id={`${prefix}-memory`}><stop stopColor="#fff"/><stop offset=".2" stopColor="#efe7ff" stopOpacity=".85"/><stop offset=".6" stopColor="#bda2ff" stopOpacity=".32"/><stop offset="1" stopColor="#b39af5" stopOpacity=".04"/></radialGradient>
          <radialGradient id={`${prefix}-cluster`}><stop stopColor="#fff"/><stop offset=".2" stopColor="#d7e7ff" stopOpacity=".8"/><stop offset=".65" stopColor="#a7c3ff" stopOpacity=".28"/><stop offset="1" stopColor="#8ca6e4" stopOpacity=".03"/></radialGradient>
          <radialGradient id={`${prefix}-event`}><stop stopColor="#e6faff"/><stop offset=".35" stopColor="#b1ebff" stopOpacity=".75"/><stop offset="1" stopColor="#8ed4ee" stopOpacity=".06"/></radialGradient>
          <radialGradient id={`${prefix}-halo`}><stop stopColor="#d4b8ff" stopOpacity=".9"/><stop offset=".25" stopColor="#b18aff" stopOpacity=".65"/><stop offset=".6" stopColor="#9964ee" stopOpacity=".28"/><stop offset="1" stopColor="#9175e3" stopOpacity="0"/></radialGradient>
        </defs>
        <g className="starfield-distant-stars" aria-hidden="true" pointerEvents="none">{stars.map((star,index)=><g key={index} opacity={star.opacity} fill={star.warm?'#ffdbb1':'#b2c9ef'}><circle cx={star.x} cy={star.y} r={star.radius}/>{star.cross?<path d={`M ${star.x-3} ${star.y} H ${star.x+3} M ${star.x} ${star.y-3} V ${star.y+3}`} fill="none" stroke="#c8d9ff" strokeWidth=".45"/>:null}</g>)}</g>
        <g className={`starfield-world${flying?' flying':''}`} style={{transform:`translate(${size.width/2+view.x}px,${size.height/2+view.y}px) scale(${view.scale})`}} onTransitionEnd={event=>{if(event.target===event.currentTarget)setFlying(false);}}>
          {graph?.edges.map(edge=>{
            const a=points.get(edge.source),b=points.get(edge.target);if(!a||!b)return null;
            const lit=spotlight&&(edge.source===spotlight||edge.target===spotlight);
            return <path key={edge.id} aria-hidden="true" className={`starfield-link link-${edge.kind}${lit?' lit':''}${spotlight&&!lit?' dim':''}`} d={`M ${a.x} ${a.y} Q ${(a.x+b.x)/2+(a.y-b.y)*.08} ${(a.y+b.y)/2+(b.x-a.x)*.08} ${b.x} ${b.y}`}/>;
          })}
          {graph?.nodes.map(node=>{
            const point=points.get(node.id);if(!point)return null;
            const focused=node.id===selectedNode?.id,label=labels.get(node.id);
            return <g key={node.id} className={`starfield-node node-${node.kind} state-${node.state}${focused?' selected':''}${spotlight&&!neighbors.has(node.id)?' dim':''}`} style={{transform:`translate(${point.x}px,${point.y}px)`}} role="button" tabIndex={0} aria-label={`${nodeName(node)}：${node.title}`} aria-pressed={focused} onPointerDown={event=>event.stopPropagation()} onClick={()=>choose(node.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(node.id);}if(event.key==='Escape')setSelected(null);}} onFocus={()=>setHovered(node.id)} onBlur={()=>setHovered(null)} onPointerEnter={()=>setHovered(node.id)} onPointerLeave={()=>setHovered(null)}>
              <circle className="starfield-node-hit" r={24} fill="transparent"/>
              {node.kind!=='event'&&node.state!=='historical'?<circle className="starfield-node-aura" r={node.kind==='group'?9:8} fill={`url(#${prefix}-halo)`}/>:null}
              <circle className="starfield-node-orbit" r={point.radius+7}/>
              <path className="starfield-node-body" d={starShape(point.radius)} fill={node.kind==='group'?`url(#${prefix}-cluster)`:node.kind==='memory'&&node.state==='current'?`url(#${prefix}-memory)`:node.kind==='event'?`url(#${prefix}-event)`:undefined}/>
              {node.state!=='historical'?<path className="starfield-core-glint" d={starShape(point.radius*.37)}/>:null}
              {label?<text className="starfield-node-label" x={label.x} y={label.y} textAnchor={label.anchor}>{short(node.title,node.kind==='group'?15:12)}</text>:null}
            </g>;
          })}
        </g>
      </svg>
      {!graph&&!error?<div className="starfield-empty" role="status"><Orbit size={30}/><p>正在连接记忆…</p></div>:graph&&!graph.nodes.length?<div className="starfield-empty"><Compass size={32}/><h3>{query?'没有找到这段记忆':'星空还在等待第一段记忆'}</h3><p>{query?'换一个关键词，或选择其他星群。':'继续和希微交流，新的记忆会在这里连起来。'}</p></div>:null}
      {error?<div className="starfield-error" role="alert"><p>{error}</p><button type="button" onClick={()=>setRetry(v=>v+1)}>重新连接</button></div>:null}
      {hoveredNode&&hoveredPoint?<div className="starfield-hover" role="tooltip" style={{left:Math.max(12,Math.min(size.width-237,size.width/2+view.x+hoveredPoint.x*view.scale+17)),top:Math.max(12,Math.min(size.height-120,size.height/2+view.y+hoveredPoint.y*view.scale-72))}}><span>{nodeName(hoveredNode)}</span><strong>{hoveredNode.title}</strong><p>{short(hoveredNode.content,110)}</p></div>:null}
      <div className="starfield-map-controls"><button type="button" aria-label="打开节点目录" aria-pressed={showDirectory} onClick={()=>{setShowDirectory(v=>!v);setSelected(null);}}><List size={16}/></button><span/><button type="button" aria-label="缩小图谱" onClick={()=>zoom(-.15)} disabled={view.scale<=.45}><ZoomOut size={16}/></button><output>{Math.round(view.scale*100)}%</output><button type="button" aria-label="放大图谱" onClick={()=>zoom(.15)} disabled={view.scale>=2.8}><ZoomIn size={16}/></button><span/><button type="button" aria-label="重置图谱视角" onClick={()=>setView({x:0,y:0,scale:1})}><Focus size={16}/></button></div>
      {showDirectory?<aside className="starfield-detail starfield-directory"><header><h3>节点目录</h3><button type="button" aria-label="关闭节点目录" onClick={()=>setShowDirectory(false)}><X size={14}/></button></header><div className="starfield-detail-body">{graph?.nodes.filter(n=>n.kind!=='group').map(node=><button type="button" key={node.id} onClick={()=>choose(node.id)}><i className={`starfield-dot ${node.kind} ${node.state}`}/><span>{node.title}</span><ChevronRight size={12}/></button>)}</div></aside>:null}
      {selectedNode?<aside className="starfield-detail" aria-label="节点详情"><header><span className={`starfield-kind ${selectedNode.state}`}><i className={`starfield-dot ${selectedNode.kind} ${selectedNode.state}`}/>{nodeName(selectedNode)}</span><button type="button" aria-label="关闭节点详情" onClick={dismiss}><X size={14}/></button></header><div className="starfield-detail-body"><h3>{selectedNode.title}</h3><p className="starfield-detail-content">{selectedNode.content}</p><dl><div><dt>所在星群</dt><dd>{selectedNode.projectName||'日常与偏好'}</dd></div>{selectedNode.updatedAt?<div><dt>{selectedNode.kind==='memory'?'最近整理':'记录时间'}</dt><dd>{time(selectedNode.updatedAt)}</dd></div>:null}{selectedNode.revision?<div><dt>记忆版本</dt><dd>v{selectedNode.revision}</dd></div>:null}</dl>{selectedNode.source?.kind==='document'?<button className="starfield-open-source" type="button" onClick={()=>onOpenDocument(selectedNode.source!.id)}><FileText size={13}/>查看原文<ArrowUpRight size={13}/></button>:selectedNode.source?.kind==='message'?<button className="starfield-open-source" type="button" onClick={onOpenChat}>查看聊天<ArrowUpRight size={13}/></button>:null}<div className="starfield-relations"><h4>关联脉络<span>{related.length}</span></h4>{related.slice(0,18).map(({edge,node})=><button type="button" key={edge.id} onClick={()=>choose(node.id)}><i className={`starfield-dot ${node.kind} ${node.state}`}/><span><strong>{node.title}</strong><small>{edge.kind==='updates'?(edge.target===selectedNode.id?'之前的状态':'更新后的状态'):edge.label}</small></span><ChevronRight size={12}/></button>)}</div></div></aside>:null}
    </div>
    <footer className="starfield-footer"><div className="starfield-legend"><span><i className="starfield-dot memory"/>记忆</span><span><i className="starfield-dot event"/>事件</span><span><i className="starfield-dot historical"/>历史</span></div><p>{graph?.limited?`展示最近 ${graph.stats.memories} 条 · 可搜索更早记忆`:graph?`${graph.stats.events} 个事件 · ${graph.stats.connections} 条连接`:'连接有来源的记忆'}</p>{preview?<button type="button" className="starfield-demo" disabled={demoBusy} onClick={()=>void demoChange()}>{demoBusy?<LoaderCircle size={12} className="spin"/>:<ArrowDownUp size={12}/>}演示记忆变化</button>:<span className="starfield-update-time">{graph?.updatedAt?`更新于 ${time(graph.updatedAt)}`:''}</span>}</footer>
  </section>;
}
