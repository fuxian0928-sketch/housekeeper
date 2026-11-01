import type {ChatCitation} from '../../types';
import {excerptPreview} from '../agent/source-preview';

export type CitationGroup = {key: string; title: string; items: ChatCitation[]; kind: 'document' | 'external' | 'evidence'; excerpt: string};
export function externalCitationUrl(path: string) {
  try {const url = new URL(path); return ['https:', 'http:'].includes(url.protocol) ? url.href : null;} catch {return null;}
}
export function groupCitations(citations: ChatCitation[]) {
  const groups = new Map<string, CitationGroup>();
  for (const citation of citations) {
    const kind = citation.documentId ? 'document' : externalCitationUrl(citation.path) ? 'external' : 'evidence';
    const identity = citation.documentId ? ['document', citation.documentId] : [kind, citation.path || citation.document];
    const key = JSON.stringify([...identity, citation.version ?? null, citation.sourceRevision ?? null]);
    let group = groups.get(key);
    if (!group) {group = {key, title: citation.document, items: [], kind, excerpt: ''}; groups.set(key, group);}
    if (!group.items.some(item => item.parentId === citation.parentId && item.excerpt === citation.excerpt && JSON.stringify(item.locator) === JSON.stringify(citation.locator))) group.items.push(citation);
    const excerpt = excerptPreview({title: citation.document, excerpt: citation.excerpt});
    if (!group.excerpt && excerpt) group.excerpt = excerpt;
  }
  return [...groups.values()];
}
