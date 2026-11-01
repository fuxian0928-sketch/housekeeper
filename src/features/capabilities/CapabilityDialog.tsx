import {useEffect,useId,useRef,type ReactNode} from 'react';
import {X} from 'lucide-react';

export function CapabilityDialog({title,busy=false,onClose,children,className=''}:{title:string;busy?:boolean;onClose:()=>void;children:ReactNode;className?:string}) {
  const ref=useRef<HTMLDialogElement>(null),id=useId();
  useEffect(()=>{
    const dialog=ref.current,trigger=document.activeElement;
    dialog?.showModal();
    return()=>{dialog?.close();if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus({preventScroll:true});};
  },[]);
  return <dialog ref={ref} className={`capability-dialog ${className}`.trim()} aria-labelledby={id}
    onCancel={event=>{event.preventDefault();if(!busy)onClose();}}
    onClick={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}>
    <header><h2 id={id}>{title}</h2><button className="icon-button" type="button" disabled={busy} aria-label={`关闭${title}`} onClick={onClose}><X size={16}/></button></header>
    <div className="capability-dialog-body">{children}</div>
  </dialog>;
}
