import {FeedbackBanner} from '../../components/FeedbackBanner';
import {useEffect,useId,useRef,useState} from 'react';
import {LoaderCircle,X} from 'lucide-react';
import {api} from '../../api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {useWorkbenchActive} from '../conversations/useWorkbenchTabs';
const markdownPlugins=[remarkGfm];

function readingContent(content:string,title:string){
  const lines=content.split(/\r?\n/),first=lines.findIndex(line=>line.trim());
  return first>=0&&lines[first].trim()===`# ${title.trim()}`?lines.slice(first+1).join('\n').trimStart():content;
}

export function DocumentPreview({documentId,version,evidence,onClose,onTitleChange,inline=false}:{documentId:string;version?:number;evidence?:{parentId:string;sourceRevision?:string};onClose:()=>void;onTitleChange?:(title:string)=>void;inline?:boolean}){
  type PreviewDocument={title:string;content:string;relativePath?:string;sourceType?:string;documentId?:string;locator?:{startLine:number;endLine:number}};
  const dialog=useRef<HTMLDialogElement>(null),[document,setDocument]=useState<PreviewDocument|null>(null),[error,setError]=useState('');
  const titleId=useId(),titleCallback=useRef(onTitleChange);titleCallback.current=onTitleChange;
  const active=useWorkbenchActive();
  useEffect(()=>{if(document?.title)titleCallback.current?.(document.title);},[document?.title,documentId,version,evidence?.parentId]);
  useEffect(()=>{if(inline)return;const element=dialog.current;element?.showModal();return()=>element?.close();},[inline]);
  useEffect(()=>{if(!active)return;let live=true;setError('');const url=evidence?`/knowledge/rag/evidence/${encodeURIComponent(evidence.parentId)}${evidence.sourceRevision?`?sourceRevision=${encodeURIComponent(evidence.sourceRevision)}`:''}`:`/knowledge/documents/${encodeURIComponent(documentId)}${version?`/versions/${version}`:''}`;api.get<PreviewDocument>(url).then(value=>{if(evidence&&value.documentId!==documentId)throw new Error('引用与文档不匹配，请重新检索。');if(live)setDocument(value);}).catch(reason=>{if(live)setError(reason instanceof Error?reason.message:'资料暂时无法读取，请稍后重试。');});return()=>{live=false;};},[documentId,version,evidence?.parentId,evidence?.sourceRevision,active]);
  const body=<div className="record-dialog-body">{error?<FeedbackBanner tone="error">{error}</FeedbackBanner>:document?<><p className="record-source">{version?`历史版本 ${version} · 只读`:'当前资料'} · {document.relativePath}</p>{<div className="chat-answer markdown-body"><ReactMarkdown remarkPlugins={markdownPlugins} components={{a:({children,...props})=><a {...props} target="_blank" rel="noreferrer">{children}</a>}}>{readingContent(document.content,document.title)}</ReactMarkdown></div>}</>:<p role="status"><LoaderCircle size={16} className="spin"/>正在读取资料…</p>}</div>;
  if(inline)return <section className="workbench-document" aria-labelledby={titleId}>{evidence?<button className="text-button" type="button" onClick={onClose}>返回来源</button>:null}<h2 id={titleId}>{document?.title??'资料原文'}</h2>{evidence&&document?.locator?<p className="record-source">引用片段 · 解析后原文第 {document.locator.startLine}–{document.locator.endLine} 行</p>:null}{body}</section>;
  return <dialog ref={dialog} className="record-dialog record-reader-dialog" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}><header><h2 id={titleId}>{document?.title??'资料原文'}</h2><button className="icon-button" type="button" aria-label="关闭资料原文" onClick={onClose}><X size={16}/></button></header>{body}</dialog>;
}
