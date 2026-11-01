import {useId,useLayoutEffect,useRef,useState} from 'react';

export function UserMessageBubble({content}:{content:string}) {
  const id=useId(),textRef=useRef<HTMLDivElement>(null);
  const [expanded,setExpanded]=useState(false),[overflows,setOverflows]=useState(false);
  useLayoutEffect(()=>{setExpanded(false);},[content]);
  useLayoutEffect(()=>{
    const element=textRef.current;if(!element)return;
    const measure=()=>{
      const lineHeight=parseFloat(getComputedStyle(element).lineHeight)||22;
      setOverflows(element.scrollHeight>lineHeight*10+1);
    };
    measure();const observer=new ResizeObserver(measure);observer.observe(element);
    return()=>observer.disconnect();
  },[content]);
  return <>
    <div className="user-message-bubble"><div ref={textRef} id={id} className="user-message-text" data-expanded={expanded}>{content}</div></div>
    {overflows?<button className="user-message-expand" type="button" aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(value=>!value)}>{expanded?'收起':'展示全部'}</button>:null}
  </>;
}
