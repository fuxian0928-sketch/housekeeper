import {ArrowUpRight, FileText,Globe} from 'lucide-react';
import type {RunSource} from './types';
import {excerptPreview, sourceLocation} from './source-preview';

export function RunSources({sources, onOpen}: {sources: RunSource[]; onOpen: (source: RunSource) => void}) {
  return <ul className="run-sources" aria-label="引用资料">
    {sources.map(source => {
      const excerpt = excerptPreview(source);
      const external=/^https?:\/\//i.test(source.path);
      let domain='网页来源';if(external)try{domain=new URL(source.path).hostname;}catch{/* Keep the generic source label. */}
      const location = external?domain:sourceLocation(source);
      const content=<>
          <span className="run-source-icon" aria-hidden="true">{external?<Globe size={16}/>:<FileText size={16}/>}</span>
          <span className="run-source-body">
            <span className="run-source-heading"><strong>{source.title}</strong><ArrowUpRight size={14} aria-hidden="true"/></span>
            {excerpt ? <span className="run-source-excerpt">{excerpt}</span> : null}
            <span className="run-source-footer"><span className="run-source-location" title={location}>{location}</span><span className="run-source-action" aria-hidden="true">{external?'打开网页':'查看原文'}</span></span>
          </span>
      </>;
      return <li key={`${source.documentId}-${source.version ?? 'current'}-${source.parentId ?? ''}`}>
        {external?<a className="run-source" href={source.path} target="_blank" rel="noopener noreferrer" aria-label={`打开网页来源：${source.title}`}>{content}</a>:<button className="run-source" type="button" onClick={() => onOpen(source)} aria-label={`查看来源：${source.title}，${location}`}>{content}</button>}
      </li>;
    })}
  </ul>;
}
