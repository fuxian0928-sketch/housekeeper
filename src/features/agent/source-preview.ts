import type {RunSource} from './types';

export function excerptPreview(source: {title: string; excerpt: string}) {
  const lines = source.excerpt.trim().split(/\r?\n/);
  const firstLine = lines[0]?.replace(/^#{1,6}\s+/, '').trim();
  const title = source.title.trim();
  if (firstLine === title) lines.shift();
  else if (firstLine?.startsWith(`${title} > `)) lines[0] = firstLine.slice(title.length + 3);
  return lines.join('\n')
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^\n]*?\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\n]*?\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/gm, '$1：')
    .replace(/^\s{0,3}(?:>\s?|[-+*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(`+)([^`]+)\1/g, '$2')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sourceLocation(source: Pick<RunSource, 'version' | 'locator'>) {
  const parts: string[] = [];
  const locator = source.locator;
  if (source.version) parts.push(`历史版本 ${source.version}`);
  if (locator) {
    if (locator.page) parts.push(`第 ${locator.page} 页`);
    if (locator.slide) parts.push(`第 ${locator.slide} 张幻灯片`);
    if (locator.sheet) parts.push(locator.sheet);
    if (locator.rowStart) parts.push(locator.rowEnd && locator.rowEnd !== locator.rowStart
      ? `第 ${locator.rowStart}–${locator.rowEnd} 行` : `第 ${locator.rowStart} 行`);
    else if (locator.startLine > 0) parts.push(locator.endLine > locator.startLine
      ? `原文第 ${locator.startLine}–${locator.endLine} 行` : `原文第 ${locator.startLine} 行`);
    if (locator.symbol) parts.push(locator.symbol);
    if (locator.jsonPath) parts.push(locator.jsonPath);
  }
  return parts.join(' · ') || '文档原文';
}
