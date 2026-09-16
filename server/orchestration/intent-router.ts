export type WorkIntentCategory = 'knowledge_analysis' | 'work_planning' | 'document_operation' | 'memory_management' | 'conversation_control';
export type ChatIntentCategory = 'casual_chat' | 'emotional_companionship' | 'personal_reflection' | 'persona_interaction';
export type IntentMode = 'read' | 'reason' | 'write' | 'delete';

export interface WorkIntent {
  category: WorkIntentCategory;
  action: string;
  mode: IntentMode;
  object: 'project' | 'task' | 'document' | 'memory' | 'conversation';
  confidence: number;
  risk: 'none' | 'low' | 'high';
  output: 'answer' | 'summary' | 'timeline' | 'comparison' | 'plan' | 'proposal' | 'document_list';
}

export interface ChatIntent {
  category: ChatIntentCategory;
  action: 'greeting' | 'free_chat' | 'emotional_support' | 'personal_impression' | 'persona_chat';
  mode: 'reason';
  object: 'conversation';
  confidence: number;
  risk: 'none';
  output: 'answer';
}

interface IntentRouteBase {
  scope: { projectId: string | null; documentPaths: string[]; timeRange: '24h' | '7d' | '30d' | 'history' | null };
  entities: { priority: 'high' | 'medium' | 'low' | null; taskReference: string | null; dueAt: string | null; executor: 'self' | 'ai' | 'external' | null; targetPath: string | null };
  executionOrder: string[];
  requiresRetrieval: boolean;
  requiresConfirmation: boolean;
  clarification: string | null;
}

export interface WorkIntentRoute extends IntentRouteBase {
  domain: 'work';
  intents: WorkIntent[];
}

export interface ChatIntentRoute extends IntentRouteBase {
  domain: 'chat';
  intents: ChatIntent[];
}

export type IntentRoute = WorkIntentRoute | ChatIntentRoute;

const negatedWrite = /(?:不要|别|无需|不允许|不能|禁止).{0,12}(?:新建|创建|添加|增加|修改|编辑|更新|删除|移动|重命名|保存|记住)/;

function add(intents: WorkIntent[], intent: Omit<WorkIntent, 'risk' | 'output'> & Partial<Pick<WorkIntent, 'risk' | 'output'>>) {
  if (!intents.some((item) => item.action === intent.action)) intents.push({
    ...intent,
    risk: intent.risk ?? (intent.mode === 'delete' ? 'high' : intent.mode === 'write' ? 'low' : 'none'),
    output: intent.output ?? (intent.mode === 'write' || intent.mode === 'delete' ? 'proposal' : 'answer')
  });
}

export function routeWorkIntents(message: string, projectId: string | null, documentPaths: unknown): WorkIntentRoute {
  const text = message.trim();
  const intents: WorkIntent[] = [];
  const deniedWrite = negatedWrite.test(text);
  if (/(?:总结|归纳|概括|汇总)/.test(text)) add(intents, { category: 'knowledge_analysis', action: 'summarize', mode: 'reason', object: 'project', confidence: 0.9, output: 'summary' });
  if (/(?:梳理思路|理清|整理逻辑|整理大纲|梳理流程)/.test(text)) add(intents, { category: 'knowledge_analysis', action: 'organize_thoughts', mode: 'reason', object: 'document', confidence: 0.9, output: 'plan' });
  if (/(?:现状|进展|做到哪|当前情况|项目全貌)/.test(text)) add(intents, { category: 'knowledge_analysis', action: 'project_status_summary', mode: 'read', object: 'project', confidence: 0.94 });
  if (/(?:历史|之前|当时|为什么这样|演进|背景|旧版|过去)/.test(text)) add(intents, { category: 'knowledge_analysis', action: 'history_trace', mode: 'read', object: 'project', confidence: 0.88, output: 'timeline' });
  if (/(?:比较|对比|区别|差异)/.test(text)) add(intents, { category: 'knowledge_analysis', action: 'compare', mode: 'reason', object: 'document', confidence: 0.86, output: 'comparison' });
  if (/(?:哪里提到|依据是什么|来源是什么|查一下|查找|搜索|找到)/.test(text) && !/(?:文档|笔记|\.md)/i.test(text)) add(intents, { category: 'knowledge_analysis', action: 'find_information', mode: 'read', object: projectId ? 'project' : 'memory', confidence: 0.82 });
  if (/(?:下一步|接下来|应该做什么|建议|怎么推进)/.test(text)) add(intents, { category: 'work_planning', action: 'recommend_next_steps', mode: 'reason', object: 'project', confidence: 0.92 });
  if (/(?:产品方案|产品规划|技术方案|设计方案|需求方案)/.test(text)) add(intents, { category: 'work_planning', action: 'plan_solution', mode: 'reason', object: 'project', confidence: 0.86 });
  if (/(?:联网|互联网|网上|外部资料|最新.{0,10}(?:竞品|市场|行业)|竞品.{0,8}(?:变化|动态|趋势)|行业趋势|市场趋势)/.test(text)) add(intents, { category: 'knowledge_analysis', action: 'external_research', mode: 'reason', object: projectId ? 'project' : 'document', confidence: 0.9, output: 'comparison' });
  if (!deniedWrite && /(?:新建|创建|建立|添加|增加|转成).{0,10}任务|任务[：:\s，,]/.test(text)) add(intents, { category: 'work_planning', action: 'task_create', mode: 'write', object: 'task', confidence: 0.9 });
  if (!deniedWrite && /(?:修改|更新|编辑|调整).{0,10}任务/.test(text)) add(intents, { category: 'work_planning', action: 'task_update', mode: 'write', object: 'task', confidence: 0.9 });
  if (!deniedWrite && /(?:取消|删除).{0,10}任务/.test(text)) add(intents, { category: 'work_planning', action: 'task_cancel', mode: 'delete', object: 'task', confidence: 0.94 });
  if (!deniedWrite && /(?:拆分|合并).{0,10}任务/.test(text)) add(intents, { category: 'work_planning', action: 'task_restructure', mode: 'write', object: 'task', confidence: 0.86 });
  if (!deniedWrite && /(?:新建|创建|添加).{0,10}项目/.test(text)) add(intents, { category: 'work_planning', action: 'project_create', mode: 'write', object: 'project', confidence: 0.92 });
  if (!deniedWrite && /(?:修改|更新|编辑|暂停|完成|归档|恢复).{0,10}项目/.test(text)) add(intents, { category: 'work_planning', action: 'project_update', mode: 'write', object: 'project', confidence: 0.88 });
  if (!deniedWrite && /(?:记住|记下来|保存为记忆|以后记得)/.test(text)) add(intents, { category: 'memory_management', action: 'memory_capture', mode: 'write', object: 'memory', confidence: 0.96 });
  if (/(?:查找|回顾|以前).{0,10}(?:记忆|偏好|决策|经验)/.test(text)) add(intents, { category: 'memory_management', action: 'memory_find', mode: 'read', object: 'memory', confidence: 0.88 });
  if (!deniedWrite && /(?:(?:合并|拆分|修改|失效|替代|恢复).{0,10}记忆|记忆.{0,10}(?:合并|拆分|修改|失效|替代|恢复))/.test(text)) add(intents, { category: 'memory_management', action: 'memory_govern', mode: 'write', object: 'memory', confidence: 0.9 });
  if (/(?:查找|搜索|找到|打开|查看).{0,12}(?:文档|笔记|\.md)/i.test(text)) add(intents, { category: 'document_operation', action: 'document_find', mode: 'read', object: 'document', confidence: 0.88 });
  if (!deniedWrite && /(?:新建|创建|新增).{0,12}(?:文档|笔记|\.md)/i.test(text)) add(intents, { category: 'document_operation', action: 'document_create', mode: 'write', object: 'document', confidence: 0.94 });
  if (!deniedWrite && /(?:修改|编辑|更新|追加|补充|改写).{0,12}(?:文档|笔记|\.md)/i.test(text)) add(intents, { category: 'document_operation', action: 'document_modify', mode: 'write', object: 'document', confidence: 0.92 });
  if (!deniedWrite && /(?:删除|移入回收站).{0,12}(?:文档|笔记|\.md)/i.test(text)) add(intents, { category: 'document_operation', action: 'document_delete', mode: 'delete', object: 'document', confidence: 0.96 });
  if (!deniedWrite && /(?:移动|重命名|合并|拆分|整理|补充链接|添加标签).{0,12}(?:文档|笔记|\.md)/i.test(text)) add(intents, { category: 'document_operation', action: 'document_organize', mode: 'write', object: 'document', confidence: 0.9, risk: /(?:移动|重命名|合并|拆分|批量)/.test(text) ? 'high' : 'low' });
  if (/(?:取消操作|确认修改|确认新建|确认删除|确认移动|确认重命名|确认执行|撤销上一次|停止生成|重新生成)/.test(text)) add(intents, { category: 'conversation_control', action: 'confirm_or_cancel', mode: 'write', object: 'conversation', confidence: 1, risk: /删除|移动|重命名|撤销/.test(text) ? 'high' : 'low' });
  if (!intents.length) add(intents, { category: 'knowledge_analysis', action: 'answer_question', mode: 'read', object: projectId ? 'project' : 'memory', confidence: 0.65 });

  const paths = Array.isArray(documentPaths) ? documentPaths.filter((item): item is string => typeof item === 'string').slice(0, 12) : [];
  const timeRange = /最近\s*24\s*小时|今天/.test(text) ? '24h' : /最近\s*7\s*天|本周/.test(text) ? '7d' : /最近\s*30\s*天|本月/.test(text) ? '30d' : /历史|之前|过去|当时|旧版/.test(text) ? 'history' : null;
  const writeIntents = intents.filter((intent) => intent.mode === 'write' || intent.mode === 'delete');
  const ambiguousDocumentWrite = writeIntents.some((intent) => intent.object === 'document') && paths.length === 0 && !/[\\/][^\\/]+\.md\b|[^\s，。]+\.md\b/i.test(text);
  return {
    domain: 'work',
    intents,
    scope: { projectId, documentPaths: paths, timeRange },
    entities: {
      priority: /紧急|高优先/.test(text) ? 'high' : /低优先/.test(text) ? 'low' : null,
      taskReference: text.match(/第[一二三四五六七八九十\d]+项|这个任务|上一个任务/)?.[0] ?? null,
      dueAt: text.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/)?.[0]?.replaceAll('/', '-') ?? null,
      executor: /交给\s*AI|AI执行/.test(text) ? 'ai' : /外部|供应商|第三方/.test(text) ? 'external' : /我来|自己处理/.test(text) ? 'self' : null,
      targetPath: text.match(/(?:[^\s，。；;]+[\\/])*[^\s，。；;]+\.md/i)?.[0] ?? null
    },
    executionOrder: intents.map((intent) => intent.action),
    requiresRetrieval: intents.some((intent) => intent.mode === 'read' || intent.mode === 'reason'),
    requiresConfirmation: writeIntents.length > 0,
    clarification: ambiguousDocumentWrite ? '请明确要操作的 Obsidian 文档路径。' : null
  };
}

function routeChatIntent(message: string): ChatIntentRoute {
  const text = message.trim();
  const personalImpression = /(?:你(?:现在)?(?:觉得|认为|看)我|你对我的印象|我(?:是|算)什么样的人|怎么看我|评价一下我)/.test(text);
  const emotionalSupport = /(?:难过|伤心|孤独|寂寞|焦虑|烦躁|委屈|压力大|好累|累死|不开心|心情不好|安慰我|抱抱|哄哄我)/.test(text);
  const personaChat = /(?:萌妹|撒个娇|撒娇|叫我|陪我|想你|喜欢你|聊天模式|闲聊模式)/.test(text);
  const greeting = /^(?:嗨|哈喽|hello|hi|你好|早上好|中午好|下午好|晚上好|晚安|在吗)[呀啊哦~～！!。.？?]*$/i.test(text);
  const intent: ChatIntent = personalImpression
    ? { category: 'personal_reflection', action: 'personal_impression', mode: 'reason', object: 'conversation', confidence: 0.96, risk: 'none', output: 'answer' }
    : emotionalSupport
      ? { category: 'emotional_companionship', action: 'emotional_support', mode: 'reason', object: 'conversation', confidence: 0.94, risk: 'none', output: 'answer' }
      : personaChat
        ? { category: 'persona_interaction', action: 'persona_chat', mode: 'reason', object: 'conversation', confidence: 0.92, risk: 'none', output: 'answer' }
        : { category: 'casual_chat', action: greeting ? 'greeting' : 'free_chat', mode: 'reason', object: 'conversation', confidence: greeting ? 0.95 : 0.76, risk: 'none', output: 'answer' };
  return {
    domain: 'chat',
    intents: [intent],
    scope: { projectId: null, documentPaths: [], timeRange: null },
    entities: { priority: null, taskReference: null, dueAt: null, executor: null, targetPath: null },
    executionOrder: [intent.action],
    requiresRetrieval: false,
    requiresConfirmation: false,
    clarification: null
  };
}

export function routeIntents(message: string, projectId: string | null, documentPaths: unknown): IntentRoute {
  const text = message.trim();
  const paths = Array.isArray(documentPaths) ? documentPaths.filter((item): item is string => typeof item === 'string') : [];
  const explicitWork = /(?:工作模式|Obsidian|RAG|向量库|知识库|资料库|服务器资料)/i.test(text)
    || /(?:这个|当前|该|我的|我们的|上面|前面|刚才|AI秘书).{0,12}(?:项目|产品|需求|技术|方案|任务|文档|笔记|资料|代码|接口|数据库|版本|进度)/i.test(text)
    || /(?:项目|任务|文档|笔记|资料|记忆).{0,12}(?:进度|现状|历史|下一步|总结|归纳|梳理|规划|修改|编辑|更新|删除|查找|搜索)/i.test(text)
    || /(?:新建|创建|建立|修改|编辑|更新|删除|移动|重命名|确认执行|记住|保存为记忆).{0,12}(?:项目|任务|文档|笔记|记忆)/i.test(text)
    || /(?:查找|搜索|检索|读取|打开|引用|根据|结合|总结|归纳).{0,12}(?:项目|文档|资料|笔记|记忆)/i.test(text)
    || /(?:(?:合并|拆分|修改|失效|替代|恢复).{0,10}记忆|记忆.{0,10}(?:合并|拆分|修改|失效|替代|恢复)|撤销上一次|取消操作)/i.test(text)
    || /(?:联网|互联网|网上|外部资料|竞品|行业趋势|市场趋势).{0,16}(?:项目|产品|方案|变化|动态|趋势|研究|分析)?/i.test(text);
  // Merely viewing a project does not mean every message is a project query.
  // Without an explicit work signal or an attached document, default to a
  // non-RAG conversation so ordinary questions cannot surface random chunks.
  if (!paths.length && !explicitWork) return routeChatIntent(text);
  return routeWorkIntents(text, projectId, paths);
}

export function intentContext(route: IntentRoute) {
  if (route.domain === 'chat') return `一级意图：聊天\n二级意图：${route.intents[0]?.category ?? 'casual_chat'}\n${route.requiresRetrieval ? '本轮需结合项目事实自然回应。' : '本轮无需项目检索，直接自然回应。'}`;
  return `一级意图：工作\n二级意图：${route.intents.map((intent) => intent.category).join(' → ')}\n三级意图：${route.intents.map((intent) => `${intent.action}(${intent.mode})`).join(' → ')}\n时间范围：${route.scope.timeRange ?? '未指定'}\n${route.entities.taskReference ? `指代对象：${route.entities.taskReference}\n` : ''}写操作需确认：${route.requiresConfirmation ? '是' : '否'}`;
}
