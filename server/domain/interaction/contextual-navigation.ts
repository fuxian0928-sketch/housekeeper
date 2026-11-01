import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { database } from '../../db.js';

export type NavigationKind = 'project' | 'document' | 'task' | 'page';
export interface NavigationTarget { kind: NavigationKind; id?: string; title: string }

/** These identifiers mirror the pages that App can actually display. */
export const NAVIGATION_PAGES = {
  home: { title: '总览', aliases: ['首页', '总览', 'home'] },
  conversations: { title: '工作台', aliases: ['工作台', '对话', '聊天', 'conversations'] },
  projects: { title: '项目管理', aliases: ['项目管理', '项目列表', '项目', 'projects'] },
  tasks: { title: '待办事项', aliases: ['待办事项', '任务列表', '待办列表', '待办', 'tasks'] },
  knowledge: { title: '知识与文档', aliases: ['知识与文档', '知识文档', '知识库', '个人知识库', '资料库', '文档列表', 'knowledge'] },
  memory: { title: '长期记忆', aliases: ['长期记忆', '记忆', 'memory'] },
  capabilities: { title: '能力中心', aliases: ['能力中心', '技能', 'capabilities'] },
  trash: { title: '项目回收站', aliases: ['项目回收站', '回收站', 'trash'] },
  settings: { title: '设置', aliases: ['设置', '配置', 'settings'] }
} as const;
export type NavigationPageId = keyof typeof NAVIGATION_PAGES;

export interface ReferenceRequest {
  query: string;
  kind?: NavigationKind;
  /** A supplied project is a hard boundary, including for names, focus and history. */
  projectId?: string | null;
  /** Inject only the actual UI selection, never a model-supplied guess. */
  focus?: NavigationTarget | null;
  /** Inject only successfully read/opened targets from this conversation/session. */
  recentTargets?: readonly NavigationTarget[];
}
export interface ReferenceResolution {
  status: 'resolved' | 'ambiguous' | 'missing';
  target?: NavigationTarget;
  candidates: NavigationTarget[];
  reason: string;
}
export type NavigationValidation =
  | { valid: true; target: NavigationTarget; reason: string }
  | { valid: false; reason: string; target?: never };

export const MAX_NAVIGATION_CANDIDATES = 5;
const LOOKUP_LIMIT = 50;
const MAX_RECENT_TARGETS = 20;
const HEADER_CHARS = 4096;
const MAX_QUERY_CHARS = 500;
const kinds: readonly NavigationKind[] = ['project', 'document', 'task', 'page'];
const kindLabel: Record<NavigationKind, string> = { project: '项目', document: '文档', task: '任务', page: '页面' };
const visibleProject = (alias: string) => `${alias}.deleted_at IS NULL AND ${alias}.status <> 'archived'`;
type Store = Pick<DatabaseSync, 'prepare'>;
type EntityRow = { id: string; title: string; relative_path?: string; header?: string };
type Lookup = { targets: NavigationTarget[]; truncated: boolean };
function entityTarget(kind: NavigationKind, row: EntityRow): NavigationTarget {
  return { kind, id: row.id, title: row.title.slice(0, MAX_QUERY_CHARS) };
}

function normalized(value: string) { return value.trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' '); }
function uniqueTargets(targets: NavigationTarget[]) {
  return [...new Map(targets.map(target => [`${target.kind}:${target.id}`, target])).values()];
}
function result(status: ReferenceResolution['status'], targets: NavigationTarget[], reason: string): ReferenceResolution {
  const candidates = uniqueTargets(targets).slice(0, MAX_NAVIGATION_CANDIDATES);
  return { status, ...(status === 'resolved' ? { target: candidates[0] } : {}), candidates, reason };
}
function stripExtension(value: string) { return value.replace(/\.(?:md|markdown)$/i, ''); }

/** Parse only simple, literal Obsidian aliases, never arbitrary YAML or body text. */
function documentAliases(header: string) {
  const metadata = header.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/)?.[1];
  if (!metadata) return [];
  const lines = metadata.split(/\r?\n/);
  const aliases: string[] = [];
  const literal = (raw: string) => {
    const value = raw.trim();
    if (value.startsWith('"')) {
      try { const parsed: unknown = JSON.parse(value); return typeof parsed === 'string' ? parsed : ''; } catch { return ''; }
    }
    if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? value.slice(1, -1).replace(/''/g, "'") : '';
    if (/^[!&*{[>|]/.test(value) || /^(?:null|true|false|~)$/i.test(value)) return '';
    return value.replace(/\s+#.*$/, '').trim();
  };
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(?:aliases|alias)[ \t]*:[ \t]*(.*)$/i);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline.startsWith('[') && inline.endsWith(']')) {
      const values = inline.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+/g) ?? [];
      aliases.push(...values.map(literal));
    } else if (inline) {
      aliases.push(literal(inline));
    } else {
      for (let next = index + 1; next < lines.length; next += 1) {
        const item = lines[next].match(/^[ \t]*-[ \t]+(.+)$/);
        if (!item) break;
        aliases.push(literal(item[1]));
      }
    }
  }
  return aliases.filter(alias => alias && alias.length <= 200).slice(0, 32);
}
function rowNames(row: EntityRow, kind: NavigationKind) {
  const names = [row.id, row.title];
  if (kind === 'document' && row.relative_path) {
    const path = row.relative_path.replace(/\\/g, '/');
    const basename = path.split('/').at(-1) ?? path;
    names.push(path, stripExtension(path), basename, stripExtension(basename), ...documentAliases(row.header ?? ''));
  }
  return names.map(normalized);
}

function referenceText(query: string) {
  let text = query.trim().replace(/[。！!？?]+$/, '').trim();
  text = text.replace(/^(?:请(?:帮我|给我)?|麻烦(?:你)?|帮我|给我)[，,\s]*/i, '');
  text = text.replace(/^(?:(?:打开|调出|切换到|进入|返回|回到|查看|显示|找到|找一下|看看|看一下|看下)(?:一下)?|open|show me|go to)\s*/i, '');
  text = text.replace(/(?:给我看看|让我看看|看一下|看看|一下|好吗|好么|可以吗|谢谢|吧)$/, '').trim();
  const quoted = [...text.matchAll(/[《「“"]([^》」”"\r\n]{1,200})[》」”"]/g)].map(match => normalized(match[1]));
  const isPageName = Object.values(NAVIGATION_PAGES).some(page => page.aliases.some(alias => normalized(alias) === normalized(text)));
  const inferredKind: NavigationKind | undefined = isPageName ? undefined : /(?:项目|project)$/i.test(text) ? 'project'
    : /(?:文档|文件|笔记|资料|document|file|note)$/i.test(text) ? 'document'
      : /(?:任务|待办|事项|事情|件事|task)$/i.test(text) ? 'task'
        : /(?:页面|界面|page)$/i.test(text) ? 'page' : undefined;
  const deictic = quoted.length === 0 && /^(?:(?:刚才|刚刚|上次|之前|前面|最近|当前|现在)(?:说的|提到的|看过的|打开的|查看的|在看的|的)?(?:这|那)?(?:个|份|件)?|(?:正在|现在|当前)(?:看|查看|打开)的?|(?:这|那)(?:个|份|件)?)(?:项目|文档|文件|笔记|资料|任务|待办|事项|事情|事|页面|界面)?$|^(?:this|that|last|previous|current)(?:\s+(?:project|document|file|note|task|page))?$/i.test(text);
  const historical = /^(?:上次|之前|前面|last|previous)/i.test(text);
  const current = /^(?:这|当前|现在|正在|this|current)/i.test(text);
  const primary = quoted.length ? quoted : [normalized(text)];
  const bareName = text.replace(/^(?:项目|文档|文件|笔记|任务|待办|页面|界面)[：:\s]+/, '').replace(/(?:的)?(?:项目|文档|文件|笔记|任务|待办|页面|界面)$/i, '').trim();
  const secondary = !quoted.length && bareName && normalized(bareName) !== primary[0] ? [normalized(bareName)] : [];
  return { primary, secondary, inferredKind, deictic, historical, current };
}

/** Read-only service; it never changes scope, opens a page, or claims progress. */
export function createContextualNavigationService(store: Store) {
  function scopeProblem(projectId: string | null | undefined) {
    if (projectId === undefined || projectId === null) return null;
    if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 200) return '项目范围无效，请重新选择项目。';
    return store.prepare(`SELECT id FROM projects WHERE id=? AND ${visibleProject('projects')}`).get(projectId)
      ? null : '当前项目不存在、已删除或已归档，请重新选择项目。';
  }

  function rows(kind: Exclude<NavigationKind, 'page'>, projectId: string | null | undefined, predicate: string, values: SQLInputValue[], limit: number): EntityRow[] {
    let from: string;
    let fields: string;
    let scope: string;
    const scopeValues: SQLInputValue[] = [];
    if (kind === 'project') {
      from = 'projects p'; fields = 'p.id,p.name AS title'; scope = visibleProject('p');
      if (projectId != null) { scope += ' AND p.id=?'; scopeValues.push(projectId); }
    } else if (kind === 'task') {
      from = 'tasks t JOIN projects p ON p.id=t.project_id'; fields = 't.id,t.title';
      scope = `${visibleProject('p')} AND t.status <> 'archived'`;
      if (projectId != null) { scope += ' AND t.project_id=?'; scopeValues.push(projectId); }
    } else {
      from = 'knowledge_documents d'; fields = `d.id,d.title,d.relative_path,CASE WHEN instr(substr(d.content,1,4),'---')>0 THEN substr(d.content,1,${HEADER_CHARS}) ELSE '' END AS header`;
      // Central tombstones may temporarily outlive a stale knowledge-index row.
      scope = 'NOT EXISTS (SELECT 1 FROM central_source_documents s WHERE s.knowledge_path=d.relative_path AND s.deleted_at IS NOT NULL)';
      if (projectId != null) {
        scope += ` AND EXISTS (SELECT 1 FROM projects p WHERE p.id=? AND ${visibleProject('p')} AND (
          EXISTS (SELECT 1 FROM project_document_links l WHERE l.document_id=d.id AND l.project_id=p.id)
          OR (p.source_path<>'' AND (d.relative_path=p.source_path OR substr(d.relative_path,1,length(p.source_path)+1)=p.source_path||'/'))
          OR EXISTS (SELECT 1 FROM task_document_links l JOIN tasks t ON t.id=l.task_id WHERE l.document_id=d.id AND t.project_id=p.id AND t.status<>'archived')
        ))`;
        scopeValues.push(projectId);
      }
    }
    return store.prepare(`SELECT ${fields} FROM ${from} WHERE ${scope} AND (${predicate}) ORDER BY 2 COLLATE NOCASE,1 LIMIT ?`)
      .all(...scopeValues, ...values, limit) as EntityRow[];
  }

  function validateNavigationTarget(input: unknown, projectId?: string | null): NavigationValidation {
    const problem = scopeProblem(projectId);
    if (problem) return { valid: false, reason: problem };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, reason: '导航目标格式无效。' };
    const item = input as Record<string, unknown>;
    if (!kinds.includes(item.kind as NavigationKind) || typeof item.id !== 'string' || !item.id || item.id.length > 200 || typeof item.title !== 'string' || !item.title.trim() || item.title.length > MAX_QUERY_CHARS) {
      return { valid: false, reason: '导航目标必须包含有效的类型、标识和名称。' };
    }
    const kind = item.kind as NavigationKind;
    if (kind === 'page') {
      if (!Object.hasOwn(NAVIGATION_PAGES, item.id)) return { valid: false, reason: '该页面不在可打开的页面列表中。' };
      const page = NAVIGATION_PAGES[item.id as NavigationPageId];
      return { valid: true, target: { kind, id: item.id, title: page.title }, reason: '页面可打开。' };
    }
    const prefix = kind === 'project' ? 'p' : kind === 'task' ? 't' : 'd';
    const row = rows(kind, projectId, `${prefix}.id=?`, [item.id], 1)[0];
    if (!row) return { valid: false, reason: '目标不存在、已不可见或不属于当前项目。' };
    return { valid: true, target: entityTarget(kind, row), reason: '目标已核验。' };
  }

  function search(names: string[], kind: NavigationKind | undefined, projectId: string | null | undefined, exact: boolean): Lookup {
    const targets: NavigationTarget[] = [];
    let truncated = false;
    for (const candidateKind of kind ? [kind] : kinds) {
      if (candidateKind === 'page') {
        for (const [id, page] of Object.entries(NAVIGATION_PAGES)) {
          if (names.some(name => page.aliases.some(alias => exact ? normalized(alias) === name : normalized(alias).includes(name)))) {
            targets.push({ kind: 'page', id, title: page.title });
          }
        }
        continue;
      }
      const prefix = candidateKind === 'project' ? 'p' : candidateKind === 'task' ? 't' : 'd';
      const title = candidateKind === 'project' ? 'p.name' : `${prefix}.title`;
      const values: SQLInputValue[] = [];
      const clauses = names.map(name => {
        const parts = exact ? [`lower(trim(${title}))=?`, `lower(${prefix}.id)=?`] : [`instr(lower(${title}),?)>0`];
        values.push(...(exact ? [name, name] : [name]));
        if (candidateKind === 'document') {
          if (exact) {
            parts.push('lower(d.relative_path)=?', 'lower(d.relative_path)=?', 'lower(d.relative_path)=?', 'substr(lower(d.relative_path),-length(?))=?', 'substr(lower(d.relative_path),-length(?))=?', 'substr(lower(d.relative_path),-length(?))=?');
            values.push(name, `${name}.md`, `${name}.markdown`, `/${name}`, `/${name}`, `/${name}.md`, `/${name}.md`, `/${name}.markdown`, `/${name}.markdown`);
          } else { parts.push('instr(lower(d.relative_path),?)>0'); values.push(name); }
          const literalForms = [...new Set([name, name.replace(/'/g, "''"), JSON.stringify(name).slice(1, -1)])];
          parts.push(`(instr(substr(d.content,1,4),'---')>0 AND instr(lower(substr(d.content,1,${HEADER_CHARS})),'alias')>0 AND (${literalForms.map(() => `instr(lower(substr(d.content,1,${HEADER_CHARS})),?)>0`).join(' OR ')}))`);
          values.push(...literalForms);
        }
        return `(${parts.join(' OR ')})`;
      });
      const matches = rows(candidateKind, projectId, clauses.join(' OR '), values, LOOKUP_LIMIT + 1);
      truncated ||= matches.length > LOOKUP_LIMIT;
      for (const row of matches.slice(0, LOOKUP_LIMIT)) {
        if (rowNames(row, candidateKind).some(alias => names.some(name => exact ? alias === name : alias.includes(name)))) {
          targets.push(entityTarget(candidateKind, row));
        }
      }
    }
    return { targets: uniqueTargets(targets), truncated };
  }

  function resolveReference(input: ReferenceRequest): ReferenceResolution {
    if (!input || typeof input.query !== 'string' || !input.query.trim() || input.query.length > MAX_QUERY_CHARS || (input.kind !== undefined && !kinds.includes(input.kind))) {
      return result('missing', [], '请提供简短、有效的对象名称或指代。');
    }
    const problem = scopeProblem(input.projectId);
    if (problem) return result('missing', [], problem);
    const parsed = referenceText(input.query);
    const kind = input.kind ?? parsed.inferredKind;
    const label = kind ? kindLabel[kind] : '对象';
    if (parsed.deictic) {
      if (input.kind && parsed.inferredKind && input.kind !== parsed.inferredKind) return result('missing', [], '指代的对象类型不一致，请说明要找什么。');
      const check = (target: NavigationTarget | null | undefined) => {
        if (!target || (kind && target.kind !== kind)) return null;
        const validated = validateNavigationTarget(target, input.projectId);
        return validated.valid ? validated.target : null;
      };
      const focus = check(input.focus);
      if (parsed.current && focus) return result('resolved', [focus], '已按当前正在查看的对象定位。');
      const history = Array.isArray(input.recentTargets) ? input.recentTargets : [];
      const recent = uniqueTargets(history.slice(0, MAX_RECENT_TARGETS).flatMap(target => { const valid = check(target); return valid ? [valid] : []; }));
      if (recent.length === 1 && history.length <= MAX_RECENT_TARGETS) return result('resolved', recent, '已按当前会话实际读取过的对象定位。');
      if (history.length > MAX_RECENT_TARGETS) return result('ambiguous', recent, `近期记录较多，请说一下${label}名称。`);
      if (recent.length > 0) return result('ambiguous', recent, `刚才涉及多个可能的${label}，请说名称或指定一个。`);
      if (!parsed.historical && focus) return result('resolved', [focus], '已按当前正在查看的对象定位。');
      // Even a single recently updated record is not evidence of what “that” meant.
      return result('missing', [], `没有可核验的上下文，请说一下${label}名称。`);
    }
    if (!parsed.primary.every(Boolean)) return result('missing', [], `请说一下要打开的${label}名称。`);
    let exact = search(parsed.primary, kind, input.projectId, true);
    if (exact.targets.length === 0 && !exact.truncated && parsed.secondary.length) exact = search(parsed.secondary, kind, input.projectId, true);
    if (exact.targets.length === 1 && !exact.truncated && parsed.primary.length === 1) return result('resolved', exact.targets, `已找到唯一匹配的${label}。`);
    if (exact.targets.length || exact.truncated) return result('ambiguous', exact.targets, `有多个可能的${label}，请补充名称或所属项目。`);
    const partial = search([...parsed.primary, ...parsed.secondary], kind, input.projectId, false);
    if (partial.targets.length || partial.truncated) return result('ambiguous', partial.targets, `没有精确匹配，请确认候选${label}或补充完整名称。`);
    return result('missing', [], `在当前范围内没有找到这个名称的${label}，请核对名称。`);
  }
  return { resolveReference, validateNavigationTarget };
}

const defaultService = createContextualNavigationService(database);
export const resolveReference = defaultService.resolveReference;
export const validateNavigationTarget = defaultService.validateNavigationTarget;
