import {useId, useRef, useState} from 'react';
import {ArrowUpRight, FileText, Globe2, Quote, X} from 'lucide-react';
import type {ChatCitation} from '../../types';
import {sourceLocation} from '../agent/source-preview';
import {externalCitationUrl, groupCitations, type CitationGroup} from './citation-groups';
import type {DocumentEvidence} from './workbench-tabs';

type Props = {citations?: ChatCitation[]; onOpenDocument?: (id: string, version?: number, evidence?: DocumentEvidence) => void};
export function ConversationCitations({citations, onOpenDocument}: Props) {
  const [selected, setSelected] = useState<CitationGroup | null>(null);
  const titleId = useId();
  const excerptTrigger = useRef<HTMLButtonElement | null>(null);
  if (!citations?.length) return null;
  const groups = groupCitations(citations);
  return <section className="message-references" aria-label="本条回答的参考来源">
    <div className="message-references-heading"><Quote size={12} aria-hidden="true"/><span>{citations.every(item => item.path.startsWith('self://')) ? '查询依据' : '参考来源'}</span><span className="message-references-count">{groups.length} 项</span></div>
    <div className="message-reference-list">{groups.map(group => {
      const source = group.items[0], external = externalCitationUrl(source.path), Icon = group.kind === 'external' ? Globe2 : group.kind === 'document' ? FileText : Quote;
      const canOpen = Boolean(onOpenDocument && source.documentId);
      const evidenceItems=group.items.filter(item=>item.parentId).sort((a,b)=>(a.locator?.startLine??0)-(b.locator?.startLine??0));
      const metadata=[source.version?`历史版本 ${source.version}`:'',external?new URL(external).hostname:!canOpen?'引用片段':'',group.items.length>1?`${group.items.length} 处引用`:''].filter(Boolean).join(' · ');
      const title = <><span className="message-reference-icon" aria-hidden="true"><Icon size={14}/></span><span className="message-reference-title" title={group.title}>{group.title}</span><ArrowUpRight size={13} aria-hidden="true"/></>;
      return <article className="message-reference" key={group.key}>
        {external ? <a className="message-reference-open" href={external} target="_blank" rel="noreferrer" aria-label={`打开外部来源：${group.title}`}>{title}</a>
          :<button type="button" className="message-reference-open" aria-label={`${canOpen ? '打开文档' : '查看引用片段'}：${group.title}`} aria-expanded={!canOpen ? selected?.key===group.key : undefined} aria-controls={!canOpen ? `${titleId}-content` : undefined} onClick={event => {if(canOpen)onOpenDocument!(source.documentId!,source.version);else{excerptTrigger.current=event.currentTarget;setSelected(group);}}}>{title}</button>}
        {group.excerpt ? <p className="message-reference-excerpt">{group.excerpt}</p> : null}
        {metadata||canOpen&&evidenceItems.length ? <footer className="message-reference-footer">{metadata?<span>{metadata}</span>:null}
          {canOpen && evidenceItems.length ? <div className="message-reference-locations" aria-label={`${group.title}的引用位置`}>{evidenceItems.map((item,index) => <button type="button" key={`${item.parentId}-${index}`} title={`查看引用：${sourceLocation(item)}`} onClick={() => onOpenDocument!(item.documentId!, item.version, {parentId:item.parentId!,sourceRevision:item.sourceRevision})}>{item.locator ? sourceLocation({locator:item.locator}).replace(/^原文/,'') : `片段 ${index+1}`}</button>)}</div> : null}
        </footer> : null}
      </article>;
    })}</div>
    {selected ? <div className="reference-excerpt-preview" id={`${titleId}-content`} role="region" aria-labelledby={titleId}>
      <header><div><h2 id={titleId}>{selected?.title}</h2><span>已保存的引用片段</span></div><button type="button" className="icon-button" aria-label="关闭引用片段" onClick={() => {setSelected(null);excerptTrigger.current?.focus();}}><X size={15}/></button></header>
      <div>{selected?.items.map((item,index)=><blockquote key={index}><p>{item.excerpt}</p></blockquote>)}</div>
    </div> : null}
  </section>;
}
