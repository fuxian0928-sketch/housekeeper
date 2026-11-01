import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {ArrowDownToLine} from 'lucide-react';

export function ChatTranscript({conversationId,loading,hasMessages,hasEarlier=false,loadingEarlier=false,onLoadEarlier,children,active=true}:{conversationId:string|null;loading:boolean;hasMessages:boolean;hasEarlier?:boolean;loadingEarlier?:boolean;onLoadEarlier?:()=>void;children:ReactNode;active?:boolean}) {
  const scrollRef=useRef<HTMLDivElement>(null),messagesRef=useRef<HTMLDivElement>(null),following=useRef(true);
  const [atBottom,setAtBottom]=useState(true);
  const savedTop=useRef(0),previousConversation=useRef<string|null|undefined>(undefined);
  const prependAnchor=useRef<{height:number;top:number}|null>(null);
  const updatePosition=()=>{
    const element=scrollRef.current;if(!element||!active)return;
    savedTop.current=element.scrollTop;
    const bottom=element.scrollHeight-element.scrollTop-element.clientHeight<24;
    following.current=bottom;setAtBottom(bottom);
  };
  const bottom=()=>{const element=scrollRef.current;if(element&&active){element.scrollTop=element.scrollHeight;savedTop.current=element.scrollTop;setAtBottom(true);}};
  useLayoutEffect(()=>{
    if(!active)return;
    if(previousConversation.current!==conversationId){previousConversation.current=conversationId;following.current=true;}
    if(following.current)bottom();else if(scrollRef.current)scrollRef.current.scrollTop=savedTop.current;
    const frame=requestAnimationFrame(()=>{if(following.current)bottom();});
    return()=>cancelAnimationFrame(frame);
  },[conversationId,active]);
  useLayoutEffect(()=>{if(!active)return;const element=scrollRef.current;if(prependAnchor.current&&element){if(!loadingEarlier){element.scrollTop=element.scrollHeight-prependAnchor.current.height+prependAnchor.current.top;prependAnchor.current=null;updatePosition();}return;}if(following.current)bottom();},[children,loading,loadingEarlier,active]);
  useLayoutEffect(()=>{
    const element=scrollRef.current;if(!element||!active)return;
    let width=element.clientWidth,height=element.clientHeight;
    const observer=new ResizeObserver(()=>{
      if(width===element.clientWidth&&height===element.clientHeight)return;
      width=element.clientWidth;height=element.clientHeight;
      if(following.current)bottom();else updatePosition();
    });
    observer.observe(element);return()=>observer.disconnect();
  },[active]);
  useLayoutEffect(()=>{
    const messages=messagesRef.current;if(!messages||!active)return;
    const observer=new ResizeObserver(updatePosition);observer.observe(messages);
    return()=>observer.disconnect();
  },[active]);
  return <>
    <div className="chat-transcript-scroll" ref={scrollRef} role="log" tabIndex={0} aria-label="聊天消息" aria-live="off" aria-busy={loading} onScroll={updatePosition}>
      {hasEarlier?<button className="chat-load-earlier" type="button" disabled={loading||loadingEarlier} onClick={()=>{const element=scrollRef.current;if(!element)return;prependAnchor.current={height:element.scrollHeight,top:element.scrollTop};following.current=false;onLoadEarlier?.();}}>{loadingEarlier?'正在读取…':'查看更早消息'}</button>:null}
      <div ref={messagesRef} className="chat-transcript-messages">{children}</div>
    </div>
    {hasMessages&&!atBottom?<footer className="chat-transcript-footer"><button className="transcript-bottom-button" aria-label="直达最底部" type="button" disabled={loading} onClick={()=>{
      const element=scrollRef.current;if(!element)return;following.current=true;element.focus({preventScroll:true});
      element.scrollTo({top:element.scrollHeight,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    }}><ArrowDownToLine size={13} aria-hidden="true"/>回到最新</button></footer>:null}
  </>;
}
