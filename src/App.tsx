import {SettingsWorkspace} from './features/settings/SettingsWorkspace';
import {FeedbackBanner} from './components/FeedbackBanner';
import type {ClientUpdateResult} from './features/settings/client-release';
import { DatePicker } from './components/DatePicker';
import { CapabilityCenter } from './features/capabilities/CapabilityCenter';
import { DocumentPreview } from './features/agent/DocumentPreview';
import type {ComputerApi,NavigationRequest,NavigationTarget} from './features/agent/interaction-types';
import { ChatModelSelect } from './features/conversations/ChatModelSelect';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Archive, AlertTriangle, BookOpen, Check, ChevronDown, ChevronRight, Circle, Database, FileText, FolderKanban, LoaderCircle, Maximize2, Network, Paperclip, Pencil, Plus, RotateCcw, Search, ShieldCheck, Sparkles, TableProperties, Trash2, Upload, X, ZoomIn, ZoomOut } from 'lucide-react';
import { api } from './api';
import { TaskWorkspace } from './features/tasks/TaskWorkspace';
import { sortActionTasks } from './features/tasks/task-view';
import { AppIconButton, FormSelect } from './components/ui';
import { ConversationWorkspace, MarkdownAnswer, type WorkbenchPanel } from './features/conversations/ConversationWorkspace';
import {useWorkbenchDraft, useWorkbenchTabs} from './features/conversations/useWorkbenchTabs';
import {documentTabId, workbenchPageTitles, type DocumentEvidence, type WorkbenchPage, type WorkbenchTab} from './features/conversations/workbench-tabs';
import { MemoryWorkspace as MemoryWorkspaceFeature } from './features/memories/MemoryWorkspace';
import type { CompanionApi } from './features/companion/types';
import type { AppSettings, ChatAnalysisStep, ChatCitation, ChatMessage, DocumentRecord, HomeData, MemorySuggestion, Priority, Project, ProjectSuggestion, StoredConversation, Task, TaskBatchSuggestion, TaskStatus, TaskSuggestion } from './types';
import { version as CLIENT_VERSION } from '../package.json';
import './theme/refined-workbench.css';

const MemoryStarfield=lazy(()=>import('./features/memories/MemoryStarfield'));

type Page = WorkbenchPage | 'conversations';
declare global {
  interface Window {
    aiSecretary?: { installLatestUpdate: () => Promise<ClientUpdateResult>; companion: CompanionApi;computer?:ComputerApi };
  }
}
type ProjectTab = 'tasks' | 'documents';
type HomeTab = 'canvas' | 'bases';
type LongJobKind = 'knowledge' | 'project-suggestions';

async function fileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '').split(',', 2)[1] ?? '');
    reader.onerror = () => reject(new Error('无法读取所选文件。'));
    reader.readAsDataURL(file);
  });
}

interface LongJobState {
  kind: LongJobKind;
  status: 'running' | 'complete' | 'error' | 'cancelled';
  stage: string;
  message: string;
  current: number;
  total: number;
  indexed: number;
  chunks: number;
  failed: number;
  startedAt: number;
}


const statusLabel: Record<TaskStatus, string> = {
  todo: '未开始',
  doing: '进行中',
  waiting: '等待中',
  done: '已完成',
  cancelled: '已取消'
};

const priorityLabel: Record<Priority, string> = { high: '高', medium: '中', low: '低' };
const projectStatusLabel: Record<Project['status'], string> = {
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档'
};
const projectStatusOptions: ReadonlyArray<{ value: Project['status']; label: string }> = [
  { value: 'active', label: '进行中' }, { value: 'paused', label: '已暂停' }, { value: 'completed', label: '已完成' }, { value: 'archived', label: '已归档' }
];
const priorityOptions: ReadonlyArray<{ value: Priority; label: string }> = [
  { value: 'high', label: '高' }, { value: 'medium', label: '中' }, { value: 'low', label: '低' }
];
const taskStatusOptions: ReadonlyArray<{ value: TaskStatus; label: string }> = [
  { value: 'todo', label: '未开始' }, { value: 'doing', label: '进行中' }, { value: 'waiting', label: '等待中' }, { value: 'done', label: '已完成' }, { value: 'cancelled', label: '已取消' }
];
const taskExecutorOptions: ReadonlyArray<{ value: Task['executor']; label: string }> = [
  { value: 'self', label: '我自己' }, { value: 'ai', label: 'AI 秘书' }, { value: 'external', label: '外部人员' }
];

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatDateOnly(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function sortTasksByStartDesc(tasks: Task[]) {
  return [...tasks].sort((first, second) => {
    const firstStart = Date.parse(first.startAt ?? first.createdAt);
    const secondStart = Date.parse(second.startAt ?? second.createdAt);
    return (Number.isNaN(secondStart) ? 0 : secondStart) - (Number.isNaN(firstStart) ? 0 : firstStart);
  });
}


function ProjectSwitcher({ projects, selectedProjectId, onSelect }: { projects: Project[]; selectedProjectId: string | null; onSelect: (id: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedProject = selectedProjectId ? projects.find((project) => project.id === selectedProjectId) ?? null : null;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return <div className="project-switcher-wrap" ref={rootRef}>
    <button ref={triggerRef} className="project-switcher-trigger" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <span>{selectedProject?.name ?? '全部项目'}</span><ChevronDown className={open ? 'rotated' : ''} size={17} aria-hidden="true" />
    </button>
    {open ? <div className="project-switcher-menu" role="menu" aria-label="切换项目">
      <div className="project-switcher-menu-heading">切换项目</div>
      <button className={selectedProjectId === null ? 'active' : ''} type="button" role="menuitemradio" aria-checked={selectedProjectId === null} onClick={() => { onSelect(null); setOpen(false); }}><span className="project-option-copy"><strong>全部项目</strong><small>查看所有任务与完成情况</small></span><span className="project-option-check" aria-hidden="true">{selectedProjectId === null ? <Check size={15} /> : null}</span></button>
      {projects.map((project) => <button className={project.id === selectedProjectId ? 'active' : ''} type="button" role="menuitemradio" aria-checked={project.id === selectedProjectId} key={project.id} onClick={() => { onSelect(project.id); setOpen(false); }}>
        <span className="project-option-copy"><strong>{project.name}</strong><small>{project.taskCounts.open} 个未完成 · {project.documentCount} 篇文档</small></span>
        <span className="project-option-check" aria-hidden="true">{project.id === selectedProjectId ? <Check size={15} /> : null}</span>
      </button>)}
    </div> : null}
  </div>;
}


export function App() {
  const navigationGeneration=useRef(0);
  const voiceActivityGeneration=useRef(0);
  const navigateRef=useRef<(request:NavigationRequest)=>Promise<void>>(async()=>{});
  const voiceActivityRef=useRef<(event:{conversationId:string;runId?:string})=>void>(()=>{});
  const deviceIdRef=useRef<string|undefined>(undefined);
  const focusRef=useRef<NavigationTarget>({kind:'page',id:'conversations',title:'工作台'});
  useEffect(()=>{const computer=window.aiSecretary?.computer;void window.aiSecretary?.companion.getConfig().then(config=>{deviceIdRef.current=config.deviceId;});if(!computer)return;const offNavigation=computer.onNavigate(request=>{void navigateRef.current(request);});const offActivity=computer.onVoiceActivity(event=>voiceActivityRef.current(event));return()=>{offNavigation();offActivity();};},[]);
  const [quickEditTask, setQuickEditTask] = useState<Task | null>(null);
  const workbench = useWorkbenchTabs();
  const workbenchActiveRef=useRef<WorkbenchTab|null>(null);
  workbenchActiveRef.current=workbench.active??null;
  const page: Page = workbench.active?.kind === 'page' ? workbench.active.page : 'conversations';
  const previewDocumentId = workbench.active?.kind === 'document' ? workbench.active.documentId : null;
  const workbenchPanel: WorkbenchPanel = !workbench.active ? null : workbench.active.kind === 'page' || workbench.active.kind === 'document' ? 'resource' : workbench.active.kind;
  const setWorkbenchPanel = useCallback((panel: WorkbenchPanel) => {
    if (!panel) workbench.hide();
    else if (panel === 'transcript' || panel === 'results') workbench.open({id: panel, kind: panel, title: panel === 'transcript' ? '聊天记录' : '成果与进展'});
  }, [workbench.hide, workbench.open]);
  useEffect(() => window.aiSecretary?.companion.onOpenSettings(() => {workbench.open({id: 'page:settings', kind: 'page', page: 'settings', title: '设置'});}), [workbench.open]);
  const [homeTab, setHomeTab] = useState<HomeTab>('canvas');
  const [homeData, setHomeData] = useState<HomeData | null>(null);
  const [projectTab, setProjectTab] = useState<ProjectTab>('tasks');
  const [projects, setProjects] = useState<Project[]>([]);
  const [deletedProjects, setDeletedProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const chatDraftsRef = useRef<Record<string, string>>({});
  const activeChatDraftKeyRef = useRef('new:conversations:global');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const chatController = useRef<AbortController | null>(null);
  const chatViewVersion = useRef(0);
  const chatRun = useRef<{ view: number; messages: ChatMessage[]; conversationId: string | null; projectId: string | null; draftKey: string; unread: boolean; mode: 'local-retrieval' | 'local-fallback' | 'openai'; compressedAt: string | null } | null>(null);
  const [chatCompletion, setChatCompletion] = useState<{ id: string; title: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [chatMode, setChatMode] = useState<'local-retrieval' | 'local-fallback' | 'openai'>('local-retrieval');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationProjectId, setConversationProjectId] = useState<string>('global');
  const [chatModel, setChatModel] = useState('');
  const [chatReasoningEffort, setChatReasoningEffort] = useState<AppSettings['reasoningEffort']>('auto');
  const [compressedAt, setCompressedAt] = useState<string | null>(null);
  const [conversationLoadBusy, setConversationLoadBusy] = useState(false);
  const conversationLoadRequestRef = useRef(0);
  const [longJob, setLongJob] = useState<LongJobState | null>(null);
  const longJobController = useRef<AbortController | null>(null);
  const [projectSuggestionMode, setProjectSuggestionMode] = useState(false);
  const [projectSuggestions, setProjectSuggestions] = useState<ProjectSuggestion[]>([]);
  const [projectSuggestionError, setProjectSuggestionError] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  const updateChatInput = useCallback((value: string) => {
    chatDraftsRef.current[activeChatDraftKeyRef.current] = value;
    setChatInput(value);
  }, []);

  const activateChatDraft = useCallback((key: string) => {
    chatViewVersion.current += 1;
    chatDraftsRef.current[activeChatDraftKeyRef.current] = chatInput;
    activeChatDraftKeyRef.current = key;
    setChatInput(chatDraftsRef.current[key] ?? '');
  }, [chatInput]);

  const newChatDraftKey = (targetPage: Page, projectId?: string | null) => targetPage === 'conversations'
    ? `new:conversations:${projectId || 'global'}`
    : targetPage === 'projects'
      ? `new:projects:${projectId || 'none'}`
      : `new:${targetPage}`;

  const loadProjects = useCallback(async () => {
    const [data, trash] = await Promise.all([
      api.get<Project[]>('/projects?includeArchived=1'),
      api.get<Project[]>('/projects/trash')
    ]);
    setProjects(data);
    setDeletedProjects(trash);
    setSelectedProjectId((current) => current && data.some((project) => project.id === current) ? current : null);
  }, []);

  const projectDataRequest = useRef(0);
  const loadProjectData = useCallback(async (projectId: string) => {
    const requestId = ++projectDataRequest.current;
    const [taskData, documentData] = await Promise.all([
      api.get<Task[]>(`/projects/${projectId}/tasks`),
      api.get<DocumentRecord[]>(`/projects/${projectId}/documents`)
    ]);
    if (requestId !== projectDataRequest.current) return;
    setTasks(taskData);
    setDocuments(documentData);
  }, []);

  const loadSettings = useCallback(async () => {
    setSettings(await api.get<AppSettings>('/settings'));
  }, []);

  const loadHomeData = useCallback(async () => {
    setHomeData(await api.get<HomeData>('/home'));
  }, []);


  useEffect(() => {
    setLoading(true);
    Promise.all([loadProjects(), loadSettings(), loadHomeData()]).catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false));
  }, [loadHomeData, loadProjects, loadSettings]);

  useEffect(() => {
    if (page !== 'home' && page !== 'tasks' && page !== 'projects') return;
    void loadHomeData().catch((reason: Error) => setError(reason.message));
    const timer = window.setInterval(() => { void loadHomeData().catch(() => undefined); }, 5000);
    return () => window.clearInterval(timer);
  }, [loadHomeData, page]);

  useEffect(() => {
    if (!selectedProjectId) return;
    loadProjectData(selectedProjectId).catch((reason: Error) => setError(reason.message));
  }, [loadProjectData, selectedProjectId]);

  useEffect(() => {
    if (page !== 'settings' && page !== 'knowledge') return;
    loadSettings().catch((reason: Error) => setError(reason.message));
  }, [loadSettings, page]);


  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!chatCompletion) return;
    const timer = window.setTimeout(() => setChatCompletion(null), 6000);
    return () => window.clearTimeout(timer);
  }, [chatCompletion]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 3000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const updateLongJobFromEvent = (kind: LongJobKind, event: Record<string, unknown>) => {
    if (event.type !== 'progress' && event.type !== 'stage') return;
    setLongJob((current) => ({
      kind,
      status: 'running',
      stage: String(event.stage ?? current?.stage ?? 'working'),
      message: String(event.message ?? '正在处理…'),
      current: Number(event.current ?? current?.current ?? 0),
      total: Number(event.total ?? current?.total ?? 0),
      indexed: Number(event.indexed ?? current?.indexed ?? 0),
      chunks: Number(event.chunks ?? current?.chunks ?? 0),
      failed: Number(event.failed ?? current?.failed ?? 0),
      startedAt: current?.startedAt ?? Date.now()
    }));
  };

  const startProjectSuggestionScan = async () => {
    if (longJob?.status === 'running') {
      setNotice('已有资料任务正在后台运行，请等待完成或先停止。');
      return;
    }
    const controller = new AbortController();
    longJobController.current = controller;
    setProjectSuggestionMode(true);
    setProjectSuggestionError(null);
    setProjectSuggestions([]);
    setLongJob({ kind: 'project-suggestions', status: 'running', stage: 'starting', message: '正在准备分析资料…', current: 0, total: 0, indexed: 0, chunks: 0, failed: 0, startedAt: Date.now() });
    try {
      await api.stream('/projects/suggestions/stream', {}, (event) => {
        updateLongJobFromEvent('project-suggestions', event);
        if (event.type === 'complete') {
          const result = event.result as { suggestions: ProjectSuggestion[]; scannedDocuments: number; scannedChunks: number; failedCount: number };
          setProjectSuggestions(result.suggestions);
          setLongJob((current) => current ? { ...current, status: 'complete', stage: 'completed', message: `识别完成，提出 ${result.suggestions.length} 个项目建议`, indexed: result.scannedDocuments, chunks: result.scannedChunks, failed: result.failedCount } : current);
          setNotice(`模型提出了 ${result.suggestions.length} 个项目建议。`);
        } else if (event.type === 'error' || event.type === 'cancelled') {
          const message = String(event.message ?? '项目识别失败。');
          setProjectSuggestionError(message);
          setLongJob((current) => current ? { ...current, status: event.type === 'cancelled' ? 'cancelled' : 'error', message } : current);
        }
      }, controller.signal);
    } catch (reason) {
      if ((reason as Error).name === 'AbortError') {
        const message = '项目识别已停止。已完成的文档索引会保留，下次可以继续。';
        setProjectSuggestionError(message);
        setLongJob((current) => current ? { ...current, status: 'cancelled', message } : current);
      } else {
        const message = reason instanceof Error ? reason.message : '项目识别失败。';
        setProjectSuggestionError(message);
        setLongJob((current) => current ? { ...current, status: 'error', message } : current);
      }
    } finally {
      if (longJobController.current === controller) longJobController.current = null;
    }
  };

  const stopLongJob = () => longJobController.current?.abort();

  const restoreRunningChat = () => {
    const run = chatRun.current;
    if (!run) return;
    conversationLoadRequestRef.current += 1;
    setConversationLoadBusy(false);
    activateChatDraft(run.draftKey);
    run.view = chatViewVersion.current;
    setChatMessages(run.messages);
    setConversationId(run.conversationId);
    setChatMode(run.mode);
    setCompressedAt(run.compressedAt);
    run.unread = false;
    setChatCompletion(null);
    setConversationProjectId(run.projectId ?? 'global');
    setWorkbenchPanel('transcript');
    setChatOpen(false);
  };

  const switchPage = (nextPage: Page) => {
    navigationGeneration.current++;
    if (nextPage === 'conversations') setWorkbenchPanel('transcript');
    else workbench.open({id: `page:${nextPage}`, kind: 'page', page: nextPage, title: workbenchPageTitles[nextPage]});
    setChatOpen(false);
  };

  const selectProject = (id: string | null) => {
    if (id !== selectedProjectId) {
      projectDataRequest.current += 1;
      setTasks([]);
      setDocuments([]);
    }
    setEditingTaskId(null);
    setShowTaskForm(false);
    setSelectedProjectId(id);
    setProjectTab('tasks');
  };

  const startNewConversation = (draftKey = newChatDraftKey('conversations', 'global')) => {
    conversationLoadRequestRef.current += 1;
    setConversationLoadBusy(false);
    activateChatDraft(draftKey);
    setChatMessages([]);
    setConversationId(null);
    setChatMode('local-retrieval');
    setCompressedAt(null);
    setConversationProjectId('global');
  };

  const startConversationPageChat = () => {
    setWorkbenchPanel('transcript');
    setChatOpen(false);
    startNewConversation();
  };

  const openConversationFromSidebar = async (id: string) => {
    if (chatRun.current?.conversationId === id && (chatController.current || chatRun.current.unread)) {
      restoreRunningChat();
      return;
    }
    const requestId = ++conversationLoadRequestRef.current;
    setConversationLoadBusy(true);
    try {
      const conversation = await api.get<StoredConversation>(`/conversations/${id}`);
      if (requestId !== conversationLoadRequestRef.current) return;
      activateChatDraft(`conversation:${conversation.id}`);
      setWorkbenchPanel('transcript');
      setChatOpen(false);
      setConversationProjectId(conversation.channel==='voice'?conversation.businessProjectId??'global':conversation.scope==='project'&&conversation.projectId?conversation.projectId:'global');
      setChatMessages(conversation.messages);
      setConversationId(conversation.id);
      setCompressedAt(conversation.compressedAt ?? null);
      setChatMode('local-retrieval');
    } catch (reason) {
      if (requestId === conversationLoadRequestRef.current) setError(reason instanceof Error ? reason.message : '对话恢复失败。');
    } finally {
      if (requestId === conversationLoadRequestRef.current) setConversationLoadBusy(false);
    }
  };

  const refreshSelectedProject = async () => {
    await Promise.all([loadProjects(), loadHomeData(), selectedProjectId ? loadProjectData(selectedProjectId) : Promise.resolve()]);
  };

  const scanVault = async () => {
    if (!selectedProjectId) return;
    setError(null);
    setNotice('正在更新全局 Obsidian 资料库…');
    try {
      const result = await api.post<{ indexed: number; chunks: number; failed: unknown[] }>(`/projects/${selectedProjectId}/scan`);
      await refreshSelectedProject();
      setNotice(`全局资料库已更新：${result.indexed} 篇 Markdown，${result.chunks} 个检索片段${result.failed.length ? `，${result.failed.length} 篇未成功` : ''}。`);
    } catch (reason) {
      setNotice(null);
      setError(reason instanceof Error ? reason.message : '扫描失败。');
    }
  };

  const createTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedProjectId || !taskTitle.trim()) return;
    try {
      await api.post(`/projects/${selectedProjectId}/tasks`, { title: taskTitle.trim(), priority: 'medium', executor: 'self' });
      setTaskTitle('');
      setShowTaskForm(false);
      await refreshSelectedProject();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务创建失败。');
    }
  };

  const pendingTaskUpdates = useRef(new Set<string>());
  const toggleTask = async (task: Task) => {
    if (pendingTaskUpdates.current.has(task.id)) return;
    pendingTaskUpdates.current.add(task.id);
    const nextStatus: TaskStatus = task.status === 'done' || task.status === 'cancelled' ? 'todo' : 'done';
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: nextStatus } : item));
    try {
      await api.patch(`/tasks/${task.id}`, { status: nextStatus });
      await refreshSelectedProject();
    } catch (reason) {
      setTasks((current) => current.map((item) => item.id === task.id ? task : item));
      setError(reason instanceof Error ? reason.message : '任务更新失败。');
    } finally { pendingTaskUpdates.current.delete(task.id); }
  };

  const updateTask = async (taskId: string, changes: Partial<Task>) => {
    try {
      await api.patch(`/tasks/${taskId}`, changes);
      setEditingTaskId(null);
      await refreshSelectedProject();
      setNotice('任务已保存。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务保存失败。');
      throw reason;
    }
  };

  const updateProject = async (changes: Partial<Project>) => {
    if (!selectedProjectId) return;
    try {
      await api.patch(`/projects/${selectedProjectId}`, changes);
      setEditingProject(false);
      await refreshSelectedProject();
      setNotice(changes.status === 'archived' ? '项目已归档，Obsidian 资料没有被删除。' : '项目信息已保存。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '项目保存失败。');
      throw reason;
    }
  };

  const deleteProject = async (confirmationName: string) => {
    if (!selectedProjectId) return;
    try {
      await api.delete(`/projects/${selectedProjectId}`, { confirmationName });
      setEditingProject(false);
      setChatOpen(false);
      await loadProjects();
      setNotice('项目已移入回收站。任务、对话、记忆和 Obsidian 文档都还在。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '项目移入回收站失败。');
      throw reason;
    }
  };

  const restoreProject = async (projectId: string) => {
    try {
      await api.post(`/projects/${projectId}/restore`);
      await loadProjects();
      setSelectedProjectId(projectId);
      switchPage('projects');
      setNotice('项目已恢复，原来的任务、对话、记忆和资料索引都可以继续使用。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '项目恢复失败。');
    }
  };

  const saveTaskSuggestion = async (suggestion: TaskSuggestion, suggestionId: string | null | undefined, messageIndex: number) => {
    if (!suggestionId) {
      setError('这条任务建议缺少确认凭证，请重新生成。');
      return;
    }
    try {
      await api.post<Task>(`/projects/${suggestion.projectId}/tasks`, { ...suggestion, suggestionId });
      setChatMessages((current) => current.map((message, index) => index === messageIndex ? { ...message, taskSuggestion: suggestion, suggestionSaved: true } : message));
      if (selectedProjectId === suggestion.projectId) await refreshSelectedProject();
      setNotice('任务已加入项目，可以在任务页继续管理。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务建议确认失败。');
    }
  };

  const saveTaskBatchSuggestion = async (suggestion: TaskBatchSuggestion, suggestionId: string | null | undefined, messageIndex: number) => {
    if (!suggestionId) { setError('这组任务建议缺少确认凭证，请重新生成。'); return; }
    try {
      const proposal = await api.post<{ id: string }>(`/projects/${suggestion.projectId}/task-batch-proposals`, { tasks: suggestion.tasks, suggestionId });
      const result = await api.post<{ created: Array<{ id: string }>; skipped: Array<{ title: string }> }>(`/actions/${proposal.id}/confirm`);
      setChatMessages((current) => current.map((message, index) => index === messageIndex ? { ...message, taskBatchSuggestion: suggestion, suggestionSaved: true } : message));
      if (selectedProjectId === suggestion.projectId) await refreshSelectedProject();
      setNotice(`已创建 ${result.created.length} 个任务${result.skipped.length ? `，跳过 ${result.skipped.length} 个重复任务` : ''}。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '批量任务确认失败。'); }
  };

  const sendChat = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message || chatController.current) return;
    const turnReasoningEffort=chatReasoningEffort;
    setChatReasoningEffort('auto');
    const streamId = `stream-${Date.now()}`;
    const userKey = `${streamId}-user`;
    const sentAt = new Date().toISOString();
    const controller = new AbortController();
    chatController.current = controller;
    // Retain a legacy conversation's archive key; business routing remains automatic.
    const archiveProjectId = conversationId && conversationProjectId !== 'global' ? conversationProjectId : null;
    const run = { view: chatViewVersion.current, messages: [...chatMessages, { role: 'user', content: message, createdAt: sentAt, clientKey: userKey }, { role: 'assistant', content: '', citations: [], analysisSteps: [], clientKey: streamId }] as ChatMessage[], conversationId, projectId: archiveProjectId, draftKey: activeChatDraftKeyRef.current, unread: false, mode: chatMode, compressedAt };
    chatRun.current = run;
    setChatCompletion(null);
    setChatMessages(run.messages);
    updateChatInput('');
    setChatBusy(true);
    const updateStreamingMessage = (updater: (message: ChatMessage) => ChatMessage) => {
      run.messages = run.messages.map((item) => item.clientKey === streamId ? updater(item) : item);
      if (run.view === chatViewVersion.current) setChatMessages(run.messages);
    };
    const reconcileSavedTimestamps = (savedConversationId: string, savedAssistantId: string) => {
      void api.get<StoredConversation>(`/conversations/${encodeURIComponent(savedConversationId)}`).then((stored) => {
        const assistantIndex = stored.messages.findIndex((item) => item.id === savedAssistantId);
        const assistant = stored.messages[assistantIndex];
        if (!assistant?.createdAt) return;
        const user = stored.messages.slice(0, assistantIndex).reverse().find((item) => item.role === 'user' && item.content === message);
        const apply = (item: ChatMessage): ChatMessage => item.clientKey === streamId
          ? { ...item, id: assistant.id, createdAt: assistant.createdAt }
          : item.clientKey === userKey && user?.createdAt ? { ...item, id: user.id, createdAt: user.createdAt } : item;
        run.messages = run.messages.map(apply);
        setChatMessages((current) => current.some((item) => item.clientKey === streamId) ? current.map(apply) : current);
      }).catch(() => undefined);
    };
    try {
      const cameraFrame=await window.aiSecretary?.companion.captureCameraFrame?.(message).catch(()=>null);
      controller.signal.throwIfAborted();
      await api.stream('/chat/stream', {
        message,
        ...(cameraFrame?{cameraFrame}:{}),
        projectId: archiveProjectId,
        scope: archiveProjectId ? 'project' : 'memory',
        projectRouting: 'auto',
        conversationId,
        interactionMode:'text',
        clientVersion: CLIENT_VERSION,
        inputId: crypto.randomUUID(),
        agentRuntime: true,
        deviceId:deviceIdRef.current,interactionContext:{focus:focusRef.current},
        model: chatModel || undefined,
        routingMode: 'auto',
        reasoningEffort: turnReasoningEffort,
        documentPaths: []
      }, (streamEvent) => {
        if(streamEvent.type==='agent-run'){
          updateStreamingMessage(item=>({...item,runId:String(streamEvent.runId)}));
          run.conversationId=String(streamEvent.conversationId);
          if(run.view===chatViewVersion.current)setConversationId(run.conversationId);
        }else if(streamEvent.type==='run-event'){
          if((streamEvent.event as {type?:string})?.type==='navigation_requested')void navigateRef.current((streamEvent.event as {detail:NavigationRequest}).detail);
          const event=streamEvent.event as {seq:number;label:string;type:string};
          updateStreamingMessage(item=>({...item,analysisSteps:[...(item.analysisSteps??[]),{id:`run:${event.seq}`,label:event.label,status:['tool_unknown','tool_failed','failed'].includes(event.type)?'warning':'done'}]}));
        }else if (streamEvent.type === 'analysis') {
          const step: ChatAnalysisStep = { id: String(streamEvent.id), label: String(streamEvent.label), status: streamEvent.status as ChatAnalysisStep['status'], detail: streamEvent.detail ? String(streamEvent.detail) : undefined };
          updateStreamingMessage((item) => ({ ...item, analysisSteps: [...(item.analysisSteps ?? []).filter((existing) => existing.id !== step.id), step] }));
        } else if (streamEvent.type === 'citations') {
          updateStreamingMessage((item) => ({ ...item, citations: streamEvent.citations as ChatCitation[] }));
        } else if (streamEvent.type === 'delta') {
          updateStreamingMessage((item) => ({ ...item, content: `${item.content}${String(streamEvent.delta ?? '')}` }));
        } else if (streamEvent.type === 'done') {
          updateStreamingMessage((item) => ({
            ...item,
            content: String(streamEvent.answer ?? item.content),
            runId:typeof streamEvent.runId==='string'?streamEvent.runId:item.runId,
            runStatus:streamEvent.runStatus as ChatMessage['runStatus'],
            citations: streamEvent.citations as ChatCitation[],
            memorySuggestion: streamEvent.memorySuggestion as MemorySuggestion | null,
            taskSuggestion: streamEvent.taskSuggestion as TaskSuggestion | null,
            taskBatchSuggestion: streamEvent.taskBatchSuggestion as TaskBatchSuggestion | null,
            suggestionId: streamEvent.suggestionId as string | null,
            createdAt: typeof streamEvent.assistantMessageAt === 'string' ? streamEvent.assistantMessageAt : new Date().toISOString()
          }));
          const nextConversationId = String(streamEvent.conversationId);
          run.conversationId = nextConversationId;
          run.mode = streamEvent.mode as typeof chatMode;
          run.draftKey = `conversation:${nextConversationId}`;
          if (run.view === chatViewVersion.current) {
            setChatMode(streamEvent.mode as 'local-retrieval' | 'local-fallback' | 'openai');
            chatDraftsRef.current[run.draftKey] = chatDraftsRef.current[activeChatDraftKeyRef.current] ?? '';
            activeChatDraftKeyRef.current = run.draftKey;
            setConversationId(nextConversationId);
          } else {
            run.unread = true;
            setChatCompletion({ id: nextConversationId, title: message.slice(0, 28) });
          }
          if (typeof streamEvent.assistantMessageId === 'string') reconcileSavedTimestamps(nextConversationId, streamEvent.assistantMessageId);
        } else if (streamEvent.type === 'error' || streamEvent.type === 'cancelled') {
          updateStreamingMessage((item) => ({ ...item, content: item.content || String(streamEvent.message ?? '回答已停止。'), createdAt: new Date().toISOString() }));
          if (run.view !== chatViewVersion.current) setNotice(String(streamEvent.message ?? '后台回答已停止。'));
        }
      }, controller.signal);
    } catch (reason) {
      if ((reason as Error).name === 'AbortError') updateStreamingMessage((item) => ({ ...item, content: item.content || '回答已停止。', createdAt: new Date().toISOString() }));
      else {
        updateStreamingMessage((item) => ({ ...item, content: reason instanceof Error ? reason.message : '对话失败。', createdAt: new Date().toISOString() }));
        if (run.view !== chatViewVersion.current) setNotice('后台回答中断，请返回聊天重试。');
      }
    } finally {
      if (chatController.current === controller) chatController.current = null;
      setChatBusy(false);
    }
  };

  const stopChat = () => {
    const runId=chatRun.current?.messages.at(-1)?.runId,controller=chatController.current;
    if(runId)void api.post(`/agent/runs/${encodeURIComponent(runId)}/control`,{action:'pause'}).catch(reason=>setError(reason.message)).finally(()=>controller?.abort());
    else controller?.abort();
  };

  const continueOfficeRun=async(runId:string,message?:string)=>{
    if(chatController.current)throw new Error('当前事务仍在处理，请先等待或暂停。');
    const view=chatViewVersion.current,controller=new AbortController(),key=crypto.randomUUID();
    const run={view,messages:[...chatMessages,{role:'assistant' as const,content:'',runId,clientKey:key}],conversationId,projectId:conversationProjectId==='global'?null:conversationProjectId,draftKey:activeChatDraftKeyRef.current,unread:false,mode:chatMode,compressedAt};
    chatRun.current=run;chatController.current=controller;setChatBusy(true);setChatMessages(run.messages);
    const update=(change:(item:ChatMessage)=>ChatMessage)=>{run.messages=run.messages.map(item=>item.clientKey===key?change(item):item);if(chatViewVersion.current===view)setChatMessages(run.messages);};
    try{
      await api.stream(`/agent/runs/${encodeURIComponent(runId)}/continue`,{message},event=>{
        if(event.type==='delta')update(item=>({...item,content:item.content+String(event.delta??'')}));
        else if(event.type==='run-event'){const step=event.event as {seq:number;label:string;type?:string;detail?:NavigationRequest};if(step.type==='navigation_requested'&&step.detail)void navigateRef.current(step.detail);update(item=>({...item,analysisSteps:[...(item.analysisSteps??[]),{id:`run:${step.seq}`,label:step.label,status:'done'}]}));}
        else if(event.type==='done'){run.conversationId=String(event.conversationId);update(item=>({...item,content:String(event.answer??item.content),runStatus:event.runStatus as ChatMessage['runStatus']}));}
        else if(event.type==='error')throw new Error(String(event.message??'继续处理未完成，进度已保留。'));
      },controller.signal);
      if(run.conversationId){const stored=await api.get<StoredConversation>(`/conversations/${encodeURIComponent(run.conversationId)}`);run.messages=stored.messages;if(chatViewVersion.current===view)setChatMessages(stored.messages);}
    }catch(reason){if((reason as Error).name==='AbortError')update(item=>({...item,content:item.content||'已暂停，进度已保留。'}));else{update(item=>({...item,content:reason instanceof Error?reason.message:'继续处理未完成。'}));throw reason;}}
    finally{if(chatController.current===controller)chatController.current=null;setChatBusy(false);}
  };

  const openTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled');
  const openWorkbenchDocument = (documentId: string, version?: number, evidence?: DocumentEvidence, title = '文档原文') => {
    navigationGeneration.current++;
    workbench.open({id: documentTabId(documentId, version, evidence), kind: 'document', documentId, version, evidence, title});
  };
  const currentFocus:NavigationTarget=workbenchPanel!=='resource'?{kind:'page',id:'conversations',title:'工作台'}:previewDocumentId?{kind:'document',id:previewDocumentId,title:workbench.active?.title??'当前文档'}:page==='tasks'&&quickEditTask?{kind:'task',id:quickEditTask.id,title:quickEditTask.title}:page==='projects'&&selectedProjectId?{kind:'project',id:selectedProjectId,title:selectedProject?.name??'当前项目'}:{kind:'page',id:page,title:workbench.active?.title??'当前页面'};
  focusRef.current=currentFocus;
  useEffect(()=>{void window.aiSecretary?.computer?.setFocus(currentFocus).catch(()=>{});},[page,workbenchPanel,previewDocumentId,quickEditTask?.id,selectedProjectId,workbench.active?.id,workbench.active?.title]);
  navigateRef.current=async request=>{
    const generation=++navigationGeneration.current;let shown=false;
    try{
      const target=request.target;
      if(target.kind==='document'&&target.id){const document=await api.get<{title:string}>('/knowledge/documents/'+encodeURIComponent(target.id));if(generation!==navigationGeneration.current)return;openWorkbenchDocument(target.id,undefined,undefined,document.title);shown=true;}
      else if(target.kind==='project'&&target.id){await api.get('/projects/'+encodeURIComponent(target.id)+'/overview');await loadProjects();if(generation!==navigationGeneration.current)return;selectProject(target.id);switchPage('projects');shown=true;}
      else if(target.kind==='task'&&target.id){const all=await api.get<HomeData>('/home');if(generation!==navigationGeneration.current)return;const task=all.tasks.find(task=>task.id===target.id);if(task){setHomeData(all);switchPage('tasks');setQuickEditTask(task);shown=true;}}
      else if(target.kind==='page'&&['home','projects','tasks','knowledge','memory','conversations','capabilities','trash','settings'].includes(target.id??'')){switchPage(target.id as Page);shown=true;}
      if(shown){focusRef.current=target;const committed=navigationGeneration.current;await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));if(committed!==navigationGeneration.current)shown=false;}
    }catch(reason){if(generation===navigationGeneration.current)setError(reason instanceof Error?reason.message:'页面未能打开。');}
    finally{await api.post('/interaction/navigation/'+encodeURIComponent(request.id)+'/ack',{token:request.token,shown}).catch(()=>{});}
  };
  voiceActivityRef.current=event=>{
    const generation=++voiceActivityGeneration.current,view=chatViewVersion.current;
    if(!chatController.current)void api.get<StoredConversation>('/conversations/'+encodeURIComponent(event.conversationId)).then(stored=>{
      if(chatController.current||generation!==voiceActivityGeneration.current||view!==chatViewVersion.current)return;
      const projectId=stored.channel==='voice'?stored.businessProjectId??'global':stored.scope==='project'&&stored.projectId?stored.projectId:'global';
      if(activeChatDraftKeyRef.current!=='conversation:'+stored.id)activateChatDraft('conversation:'+stored.id);
      setChatMessages(stored.messages);setConversationId(stored.id);setConversationProjectId(projectId);setCompressedAt(stored.compressedAt??null);setChatMode('openai');
      if(stored.messages.at(-1)?.role==='assistant')workbench.open({id:'transcript',kind:'transcript',title:'聊天记录',attention:true},Boolean(workbenchActiveRef.current));
    }).catch(()=>{});
  };
  const doneTasks = tasks.filter((task) => task.status === 'done');

  const renderResourceTab = (tab: WorkbenchTab) => {
    if (tab.kind === 'document') return <DocumentPreview inline documentId={tab.documentId} version={tab.version} evidence={tab.evidence} onTitleChange={title => workbench.title(tab.id, `${title}${tab.version ? ` · v${tab.version}` : ''}${tab.evidence ? ' · 引用片段' : ''}`)} onClose={() => workbench.close(tab.id)}/>;
    if (tab.kind !== 'page') return null;
    const resourcePage = tab.page;
    if(resourcePage==='memory-starfield')return <Suspense fallback={<div className="starfield-loading" role="status">正在展开记忆星空…</div>}><MemoryStarfield onOpenDocument={id=>openWorkbenchDocument(id)} onOpenChat={()=>setWorkbenchPanel('transcript')}/></Suspense>;
    return (
resourcePage === 'home' ? (
            <HomeWorkspace
              data={homeData}
              tab={homeTab}
              onTabChange={setHomeTab}
              onOpenProject={(projectId) => { selectProject(projectId); switchPage('projects'); }}
              onOpenKnowledge={() => switchPage('knowledge')}
            />
          ) : resourcePage === 'projects' ? (
            <ProjectWorkspace
              projects={projects}
              selectedProject={selectedProject}
              selectedProjectId={selectedProjectId}
              onSelectProject={selectProject}
              projectTab={projectTab}
              onChangeTab={setProjectTab}
              tasks={tasks}
              openTasks={openTasks}
              doneTasks={doneTasks}
              documents={documents}
              allTasks={homeData?.tasks ?? []}
              showTaskForm={showTaskForm}
              taskTitle={taskTitle}
              onTaskTitleChange={setTaskTitle}
              onShowTaskForm={setShowTaskForm}
              onCreateTask={createTask}
              onToggleTask={toggleTask}
              editingTaskId={editingTaskId}
              onEditTask={setEditingTaskId}
              onUpdateTask={updateTask}
              onScan={scanVault}
              showProjectForm={showProjectForm}
              onShowProjectForm={setShowProjectForm}
              onProjectsChanged={loadProjects}
              onRefresh={refreshSelectedProject}
              onNotice={setNotice}
              onError={setError}
              suggestionMode={projectSuggestionMode}
              suggestions={projectSuggestions}
              suggestionError={projectSuggestionError}
              suggestionJob={longJob?.kind === 'project-suggestions' ? longJob : null}
              onGenerateSuggestions={startProjectSuggestionScan}
              onSetSuggestions={setProjectSuggestions}
              onCloseSuggestions={() => { setProjectSuggestionMode(false); setProjectSuggestionError(null); }}
              editingProject={editingProject}
              onEditProject={setEditingProject}
              onUpdateProject={updateProject}
              onDeleteProject={deleteProject}
            />
          ) : resourcePage === 'tasks' ? (
            <><TaskWorkspace tasks={homeData?.tasks ?? []} projects={projects} onRefresh={refreshSelectedProject} onToggle={toggleTask} onError={setError} onEdit={setQuickEditTask} onOpenProject={(id) => { selectProject(id); switchPage('projects'); }} />{quickEditTask ? <QuickTaskEditor key={quickEditTask.id} task={quickEditTask} onClose={() => setQuickEditTask(null)} onSave={updateTask} /> : null}</>
          ) : resourcePage === 'knowledge' ? (
            <KnowledgeWorkspace projects={projects} settings={settings} onNotice={setNotice} onError={setError} />
          ) : resourcePage === 'memory' ? (
            <MemoryWorkspaceFeature
              onOpenChat={() => setWorkbenchPanel('transcript')}
            />
          ) : resourcePage==='capabilities'?<div className="settings-page surface-page capabilities-page"><CapabilityCenter hideHeading/></div>:resourcePage === 'trash' ? (
            <TrashWorkspace projects={deletedProjects} onRestore={restoreProject} />
          ) : <SettingsWorkspace settings={settings} onSaved={(next) => { setSettings(next); setNotice('设置已保存。'); }} onError={setError} />
  );
  };

  return (
    <div data-page={page} className="app-frame voice-first command-shell spectrum-shell refined-shell orbital-shell conversation-mode">
      {import.meta.env.DEV&&import.meta.env.VITE_WORKBENCH_PREVIEW==='1'?<div className="preview-notice" role="status">本地验收预览 · 示例资料与模拟回答 · 未连接个人服务器</div>:null}
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <div className="feedback-stack" id="workbench-feedback">
        {chatCompletion ? <FeedbackBanner tone="success" action={<button className="text-button" type="button" onClick={() => { void openConversationFromSidebar(chatCompletion.id); setChatCompletion(null); }}>查看</button>} onDismiss={() => setChatCompletion(null)}>希微已回复：{chatCompletion.title}</FeedbackBanner> : null}
        {error ? <FeedbackBanner tone="error" key={`error:${error}`} onDismiss={() => setError(null)}>{error}</FeedbackBanner> : null}
        {notice ? <FeedbackBanner tone="success" key={`notice:${notice}`} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner> : null}
      </div>
      <div className={`workspace ${chatOpen ? 'chat-visible' : ''}`}>
        <main className="main-surface" id="main-content">
          {longJob ? <LongJobBanner job={longJob} onStop={stopLongJob} onDismiss={() => setLongJob(null)} onOpen={() => switchPage(longJob.kind === 'knowledge' ? 'knowledge' : 'projects')} /> : null}
          {loading?<LoadingState/>:(<ConversationWorkspace
              modelSelector={<ChatModelSelect value={chatModel} onChange={setChatModel} defaultModel={settings?.model ?? ''} baseUrl={settings?.apiBaseUrl ?? ''} disabled={chatBusy} reasoningEffort={chatReasoningEffort} onReasoningEffortChange={setChatReasoningEffort} />}
              workbench={{...workbench,select:id=>{navigationGeneration.current++;workbench.select(id);},hide:()=>{navigationGeneration.current++;workbench.hide();},close:id=>{navigationGeneration.current++;workbench.close(id);}}}
              onPanelChange={setWorkbenchPanel}
              renderResourceTab={renderResourceTab}
              onOpenSettings={()=>switchPage('settings')}
              onOpenCapabilities={()=>switchPage('capabilities')}
              onOpenMemoryStarfield={()=>switchPage('memory-starfield')}
              messages={chatMessages}
              input={chatInput}
              busy={chatBusy}
              conversationLoadBusy={conversationLoadBusy}
              conversationId={conversationId}
              onInput={updateChatInput}
              onSend={sendChat}
              onStop={stopChat}
              onNew={startConversationPageChat}
              onSaveTaskSuggestion={saveTaskSuggestion}
              onSaveTaskBatchSuggestion={saveTaskBatchSuggestion}
              onContinueRun={continueOfficeRun}
              onOpenDocument={openWorkbenchDocument}
              onBusinessChanged={refreshSelectedProject}
            />)}
        </main>
      </div>
    </div>
  );
}

function LoadingState() {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" size={16} aria-hidden="true"/><span>正在准备工作台…</span></div>;
}

type HomeCanvasNode = {
  id: string;
  kind: 'vault' | 'project' | 'document';
  label: string;
  detail: string;
  x: number;
  y: number;
  projectId?: string;
  path?: string;
};

type HomeCanvasPosition = { x: number; y: number };
type HomeCanvasPositions = Record<string, HomeCanvasPosition>;

const HOME_CANVAS_LAYOUT_KEY = 'ai-secretary.home-canvas-layout.v1';
const HOME_CANVAS_DOCUMENT_LIMIT = 10;

function readHomeCanvasPositions(): HomeCanvasPositions {
  try {
    const raw = window.localStorage.getItem(HOME_CANVAS_LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
      if (!value || typeof value !== 'object') return [];
      const position = value as Partial<HomeCanvasPosition>;
      return Number.isFinite(position.x) && Number.isFinite(position.y)
        ? [[id, { x: Number(position.x), y: Number(position.y) }]]
        : [];
    }));
  } catch {
    return {};
  }
}

function saveHomeCanvasPositions(positions: HomeCanvasPositions) {
  try {
    window.localStorage.setItem(HOME_CANVAS_LAYOUT_KEY, JSON.stringify(positions));
  } catch {
    // The layout remains usable for this session when local storage is unavailable.
  }
}

function HomeWorkspace({ data, tab, onTabChange, onOpenProject, onOpenKnowledge }: { data: HomeData | null; tab: HomeTab; onTabChange: (tab: HomeTab) => void; onOpenProject: (projectId: string) => void; onOpenKnowledge: () => void }) {
  const [selectedNodeId, setSelectedNodeId] = useState('vault');
  const [zoom, setZoom] = useState(1);
  const [nodePositions, setNodePositions] = useState<HomeCanvasPositions>(readHomeCanvasPositions);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const canvasWorldRef = useRef<HTMLDivElement | null>(null);
  const nodePositionsRef = useRef(nodePositions);
  const dragRef = useRef<{ id: string; pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const [baseProjectFilter, setBaseProjectFilter] = useState('all');
  const [baseStatusFilter, setBaseStatusFilter] = useState<'all' | 'open' | 'done'>('all');
  const projectOptions = useMemo(() => [{ value: 'all', label: '全部项目' }, ...(data?.projects ?? []).map((project) => ({ value: project.id, label: project.name }))], [data?.projects]);
  const graph = useMemo(() => {
    const projects = (data?.projects ?? []).filter((project) => project.status !== 'archived').slice(0, 6);
    const projectNodes: HomeCanvasNode[] = projects.map((project, index) => {
      const angle = -Math.PI / 2 + index / Math.max(projects.length, 1) * Math.PI * 2;
      return {
        id: `project:${project.id}`,
        kind: 'project',
        label: project.name,
        detail: `${project.taskCounts.open} 个未完成 · ${project.documentCount} 篇项目文档`,
        x: 50 + Math.cos(angle) * 27,
        y: 50 + Math.sin(angle) * 30,
        projectId: project.id
      };
    });
    const projectNodeMap = new Map(projectNodes.map((node) => [node.projectId, node]));
    const documents = (data?.documents ?? []).slice(0, HOME_CANVAS_DOCUMENT_LIMIT);
    const documentNodes: HomeCanvasNode[] = documents.map((document, index) => {
      const columns = 7;
      const row = Math.floor(index / columns);
      const column = index % columns;
      const project = projects.find((item) => {
        const scope = item.sourcePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
        return Boolean(scope) && (document.relativePath === scope || document.relativePath.startsWith(`${scope}/`));
      });
      return {
        id: `document:${document.id}`,
        kind: 'document',
        label: document.title,
        detail: document.relativePath,
        x: 9 + column * 14,
        y: 8 + row * 7.2,
        projectId: project?.id,
        path: document.relativePath
      };
    });
    const documentTotal = data?.documents.length ?? 0;
    const vaultNode: HomeCanvasNode = {
      id: 'vault', kind: 'vault', label: 'Obsidian Vault', detail: `${documentTotal} 篇 Markdown · 自动检测变化`, x: 50, y: 50
    };
    const nodes = [vaultNode, ...projectNodes, ...documentNodes];
    const edges = [
      ...projectNodes.map((node) => ({ id: `vault-${node.id}`, from: vaultNode, to: node, kind: 'project' as const })),
      ...documentNodes.map((node) => ({ id: `doc-${node.id}`, from: node.projectId ? projectNodeMap.get(node.projectId) ?? vaultNode : vaultNode, to: node, kind: 'document' as const }))
    ];
    return { nodes, edges };
  }, [data]);
  const positionedGraph = useMemo(() => {
    const nodes = graph.nodes.map((node) => ({ ...node, ...(nodePositions[node.id] ?? {}) }));
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const edges = graph.edges.map((edge) => ({
      ...edge,
      from: nodesById.get(edge.from.id) ?? edge.from,
      to: nodesById.get(edge.to.id) ?? edge.to
    }));
    return { nodes, edges };
  }, [graph, nodePositions]);
  useEffect(() => {
    if (!positionedGraph.nodes.some((node) => node.id === selectedNodeId)) setSelectedNodeId('vault');
  }, [positionedGraph.nodes, selectedNodeId]);
  const selectedNode = positionedGraph.nodes.find((node) => node.id === selectedNodeId) ?? positionedGraph.nodes[0];
  const startNodeDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>, node: HomeCanvasNode) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: node.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: node.x, originY: node.y, moved: false };
    setDraggingNodeId(node.id);
  }, []);
  const moveNode = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const world = canvasWorldRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !world) return;
    const bounds = world.getBoundingClientRect();
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    drag.moved = true;
    event.preventDefault();
    const next = {
      x: Math.min(96, Math.max(4, drag.originX + deltaX / bounds.width * 100)),
      y: Math.min(94, Math.max(6, drag.originY + deltaY / bounds.height * 100))
    };
    const nextPositions = { ...nodePositionsRef.current, [drag.id]: next };
    nodePositionsRef.current = nextPositions;
    setNodePositions(nextPositions);
  }, []);
  const finishNodeDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.moved) {
      suppressClickRef.current = drag.id;
      saveHomeCanvasPositions(nodePositionsRef.current);
    }
    dragRef.current = null;
    setDraggingNodeId(null);
  }, []);
  const selectNode = useCallback((nodeId: string) => {
    if (suppressClickRef.current === nodeId) {
      suppressClickRef.current = null;
      return;
    }
    setSelectedNodeId(nodeId);
  }, []);
  const resetNodeLayout = useCallback(() => {
    nodePositionsRef.current = {};
    setNodePositions({});
    setZoom(1);
    try {
      window.localStorage.removeItem(HOME_CANVAS_LAYOUT_KEY);
    } catch {
      // Reset still applies to the current session.
    }
  }, []);
  const filteredTasks = useMemo(() => (data?.tasks ?? []).filter((task) => {
    if (baseProjectFilter !== 'all' && task.projectId !== baseProjectFilter) return false;
    if (baseStatusFilter === 'open' && ['done', 'cancelled'].includes(task.status)) return false;
    if (baseStatusFilter === 'done' && task.status !== 'done') return false;
    return true;
  }), [baseProjectFilter, baseStatusFilter, data?.tasks]);
  const projectNames = useMemo(() => new Map((data?.projects ?? []).map((project) => [project.id, project.name])), [data?.projects]);
  const openCount = (data?.tasks ?? []).filter((task) => !['done', 'cancelled'].includes(task.status)).length;
  const doneCount = (data?.tasks ?? []).filter((task) => task.status === 'done').length;

  return <section className="home-workspace">
    <header className="home-header">
      <div><h1>首页</h1><p>{tab === 'canvas' ? '项目、文档与 Obsidian 资料之间的关系。' : '项目任务形成的实时数据视图。'}</p></div>
    </header>
    <div className="home-tabs" role="tablist" aria-label="首页视图">
      <button role="tab" aria-selected={tab === 'canvas'} className={tab === 'canvas' ? 'active' : ''} type="button" onClick={() => onTabChange('canvas')}><Network size={16} />Canvas</button>
      <button role="tab" aria-selected={tab === 'bases'} className={tab === 'bases' ? 'active' : ''} type="button" onClick={() => onTabChange('bases')}><TableProperties size={16} />Bases</button>
    </div>
    {tab === 'canvas' ? <div className="home-canvas-shell">
      <div className="home-canvas-stage" aria-label="项目与资料关系图">
        <div className="home-canvas-tools" aria-label="画布缩放">
          <AppIconButton label="缩小画布" onClick={() => setZoom((current) => Math.max(.72, Number((current - .12).toFixed(2))))}><ZoomOut size={16} /></AppIconButton>
          <span>{Math.round(zoom * 100)}%</span>
          <AppIconButton label="放大画布" onClick={() => setZoom((current) => Math.min(1.36, Number((current + .12).toFixed(2))))}><ZoomIn size={16} /></AppIconButton>
          <AppIconButton label="重置画布" onClick={() => setZoom(1)}><Maximize2 size={15} /></AppIconButton>
          <span className="home-canvas-tool-divider" aria-hidden="true" />
          <AppIconButton label="恢复默认布局" onClick={resetNodeLayout}><RotateCcw size={15} /></AppIconButton>
        </div>
        {positionedGraph.nodes.length > 1 ? <div className="home-canvas-world" ref={canvasWorldRef} style={{ transform: `scale(${zoom})` }}>
          <svg className="home-canvas-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {positionedGraph.edges.map((edge) => <line className={edge.kind} key={edge.id} x1={edge.from.x} y1={edge.from.y} x2={edge.to.x} y2={edge.to.y} />)}
          </svg>
          {positionedGraph.nodes.map((node) => <button className={`home-canvas-node ${node.kind} ${selectedNodeId === node.id ? 'selected' : ''} ${draggingNodeId === node.id ? 'dragging' : ''}`} type="button" key={node.id} style={{ left: `${node.x}%`, top: `${node.y}%` }} onPointerDown={(event) => startNodeDrag(event, node)} onPointerMove={moveNode} onPointerUp={finishNodeDrag} onPointerCancel={finishNodeDrag} onClick={() => selectNode(node.id)} aria-pressed={selectedNodeId === node.id}>
            <span className="home-node-icon">{node.kind === 'vault' ? <Database size={18} /> : node.kind === 'project' ? <FolderKanban size={17} /> : <FileText size={15} />}</span>
            <span><strong>{node.label}</strong><small>{node.detail}</small></span>
          </button>)}
        </div> : <div className="home-empty"><Network size={28} /><strong>关系图还没有内容</strong><p>先读取 Obsidian 资料，或创建一个项目。</p><button className="secondary-button" type="button" onClick={onOpenKnowledge}>打开资料库</button></div>}
      </div>
      <aside className="home-canvas-inspector" aria-label="节点详情">
        <span className={`home-inspector-symbol ${selectedNode?.kind ?? 'vault'}`}>{selectedNode?.kind === 'project' ? <FolderKanban size={19} /> : selectedNode?.kind === 'document' ? <FileText size={18} /> : <Database size={19} />}</span>
        <h2>{selectedNode?.label ?? 'Obsidian Vault'}</h2>
        <p>{selectedNode?.detail ?? '暂无资料'}</p>
        <dl>
          {selectedNode?.kind === 'vault' ? <><div><dt>项目</dt><dd>{data?.projects.length ?? 0}</dd></div><div><dt>文档</dt><dd>{data?.documents.length ?? 0}</dd></div><div><dt>待办</dt><dd>{openCount}</dd></div></> : null}
          {selectedNode?.kind === 'project' ? <><div><dt>状态</dt><dd>{projectStatusLabel[data?.projects.find((project) => project.id === selectedNode.projectId)?.status ?? 'active']}</dd></div><div><dt>资料范围</dt><dd>{data?.projects.find((project) => project.id === selectedNode.projectId)?.sourcePath || '全部资料'}</dd></div></> : null}
          {selectedNode?.kind === 'document' ? <div><dt>Vault 路径</dt><dd>{selectedNode.path}</dd></div> : null}
        </dl>
        {selectedNode?.kind === 'project' && selectedNode.projectId ? <button className="primary-button" type="button" onClick={() => onOpenProject(selectedNode.projectId!)}>打开项目</button> : null}
        {selectedNode?.kind === 'document' || selectedNode?.kind === 'vault' ? <button className="secondary-button" type="button" onClick={onOpenKnowledge}>查看资料库</button> : null}
        <small className="home-inspector-note">拖动节点可以整理布局，位置会自动保存。Canvas 不会写入 Obsidian 原文。</small>
      </aside>
    </div> : <div className="home-bases-shell">
      <div className="home-bases-toolbar">
        <div className="home-bases-summary"><strong>{filteredTasks.length}</strong><span>条任务</span><i>{openCount} 未完成 · {doneCount} 已完成</i></div>
        <div className="home-bases-filters">
          <FormSelect label="筛选项目" value={baseProjectFilter} options={projectOptions} onChange={setBaseProjectFilter} />
          <div className="base-status-tabs" aria-label="筛选任务状态">
            {(['all', 'open', 'done'] as const).map((value) => <button className={baseStatusFilter === value ? 'active' : ''} type="button" aria-pressed={baseStatusFilter === value} key={value} onClick={() => setBaseStatusFilter(value)}>{value === 'all' ? '全部' : value === 'open' ? '未完成' : '已完成'}</button>)}
          </div>
        </div>
      </div>
      <div className="home-bases-table-wrap">
        {filteredTasks.length ? <table className="home-bases-table">
          <thead><tr><th>任务名称</th><th>所属项目</th><th>状态</th><th>优先级</th><th>执行方</th><th>截止时间</th></tr></thead>
          <tbody>{filteredTasks.map((task) => <tr key={task.id}>
            <td><span className={`base-task-dot ${task.status}`} /><button className="base-task-link" type="button" onClick={() => onOpenProject(task.projectId)}>{task.title}</button></td>
            <td>{projectNames.get(task.projectId) ?? '未归类项目'}</td>
            <td><span className={`base-status ${task.status}`}>{statusLabel[task.status]}</span></td>
            <td>{priorityLabel[task.priority]}</td>
            <td>{task.executor === 'self' ? '我自己' : task.executor === 'ai' ? 'AI 秘书' : '外部人员'}</td>
            <td>{formatDateOnly(task.dueAt)}</td>
          </tr>)}</tbody>
        </table> : <div className="home-empty"><TableProperties size={27} /><strong>当前筛选下没有任务</strong><p>切换项目或状态条件查看其他任务。</p></div>}
      </div>
      <p className="home-bases-footnote">Bases 直接跟随项目任务变化，不会生成或覆盖 Vault 中的 .base 文件。</p>
    </div>}
  </section>;
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒` : `${seconds} 秒`;
}

function LongJobBanner({ job, onStop, onDismiss, onOpen }: { job: LongJobState; onStop: () => void; onDismiss: () => void; onOpen: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (job.status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [job.status]);
  const isAnalyzing = job.status === 'running' && job.stage === 'analyzing';
  const percent = !isAnalyzing && job.total > 0 ? Math.min(100, Math.round(job.current / job.total * 100)) : null;
  const estimatedRemaining = !isAnalyzing && job.current > 0 && job.total > job.current ? (now - job.startedAt) / job.current * (job.total - job.current) : null;
  return <section className={`long-job-banner ${job.status}`} aria-live="polite">
    <div className="long-job-icon">{job.status === 'running' ? <LoaderCircle className="spin" size={18} /> : job.status === 'complete' ? <Check size={18} /> : <AlertTriangle size={18} />}</div>
    <div className="long-job-copy"><div><strong>{job.kind === 'knowledge' ? '资料库读取' : 'AI 识别项目'}</strong><span>{job.message}</span></div>{job.status === 'running' ? <div className="long-job-meta"><span>已运行 {formatElapsed(now - job.startedAt)}</span>{percent !== null ? <span>{job.current} / {job.total}（{percent}%）</span> : null}{estimatedRemaining ? <span>预计还需约 {formatElapsed(estimatedRemaining)}</span> : <span>{isAnalyzing ? '资料读取完成 · 正在整理项目' : '正在计算剩余时间'}</span>}</div> : <div className="long-job-meta"><span>{job.indexed} 篇文档</span><span>{job.chunks} 个检索片段</span>{job.failed ? <span>{job.failed} 篇失败</span> : null}</div>}</div>
    <div className="long-job-actions"><button className="text-button" type="button" onClick={onOpen}>查看详情</button>{job.status === 'running' ? <button className="secondary-button" type="button" onClick={onStop}>停止</button> : <AppIconButton label="关闭任务提示" onClick={onDismiss}><X size={16} /></AppIconButton>}</div>
    {job.status === 'running' ? <div className={`long-job-track${isAnalyzing ? ' indeterminate' : ''}`}><span style={{ width: percent === null ? '18%' : `${percent}%` }} /></div> : null}
  </section>;
}

function LongJobDetail({ job }: { job: LongJobState }) {
  const stages = job.kind === 'knowledge'
    ? [['discovering', '查找 Markdown 文件'], ['reading', '读取、切块并建立索引'], ['cleaning', '核对移动或删除的文件'], ['completed', '完成']] as const
    : [['discovering', '查找 Markdown 文件'], ['reading', '读取、切块并建立索引'], ['analyzing', '模型整理项目'], ['completed', '完成']] as const;
  const currentIndex = stages.findIndex(([stage]) => stage === job.stage);
  return <div className="long-job-detail" aria-label="处理步骤">
    {stages.map(([stage, label], index) => {
      const state = job.status === 'error' && index === currentIndex ? 'error' : job.status === 'cancelled' && index === currentIndex ? 'cancelled' : index < currentIndex || job.status === 'complete' ? 'done' : index === currentIndex ? 'active' : 'waiting';
      return <div className={`job-step ${state}`} key={stage}><span>{state === 'done' ? <Check size={13} /> : state === 'active' ? <LoaderCircle className="spin" size={13} /> : state === 'error' || state === 'cancelled' ? <AlertTriangle size={13} /> : null}</span><div><strong>{label}</strong>{index === currentIndex ? <p>{job.message}</p> : null}</div></div>;
    })}
  </div>;
}

function KnowledgeWorkspace({ projects, settings, onNotice, onError }: { projects: Project[]; settings: AppSettings | null; onNotice: (message: string) => void; onError: (message: string) => void; }) {
  const tab = 'documents';
  const [documentScope, setDocumentScope] = useState<'all' | string>('all');
  const [documentQuery, setDocumentQuery] = useState('');
  const documentRequest = useRef(0);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [documentsBusy, setDocumentsBusy] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<DocumentRecord | null>(null);
  const [editingDocument, setEditingDocument] = useState(false);
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [documentTitle, setDocumentTitle] = useState('');
  const [documentContent, setDocumentContent] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const officeInput = useRef<HTMLInputElement>(null);
  useWorkbenchDraft('knowledge', Boolean(editingDocument && (documentTitle !== (creatingDocument ? '' : selectedDocument?.title ?? '') || documentContent !== (creatingDocument ? '' : selectedDocument?.content ?? ''))), busy || importBusy);

  useEffect(() => {
    if (tab !== 'documents') return;
    setDocumentsBusy(true);
    const endpoint = documentScope === 'all' ? '/knowledge/documents' : `/projects/${encodeURIComponent(documentScope)}/documents`;
    let active = true;
    setDocuments([]);
    api.get<DocumentRecord[]>(endpoint).then(result => { if (active) setDocuments(result); }).catch((reason: Error) => { if (active) onError(reason.message); }).finally(() => { if (active) setDocumentsBusy(false); });
    return () => { active = false; };
  }, [documentScope, onError, tab, settings?.knowledgeDocumentCount]);

  if (!settings) return <LoadingState />;

  const reloadDocuments = async () => {
    const endpoint = documentScope === 'all' ? '/knowledge/documents' : `/projects/${encodeURIComponent(documentScope)}/documents`;
    setDocuments(await api.get<DocumentRecord[]>(endpoint));
  };

  const openDocument = async (id: string) => {
    const requestId = ++documentRequest.current;
    setDocumentsBusy(true);
    try {
      const document = await api.get<DocumentRecord>(`/knowledge/documents/${encodeURIComponent(id)}`);
      if (requestId !== documentRequest.current) return;
      setSelectedDocument(document);
      setDocumentTitle(document.title);
      setDocumentContent(document.content ?? '');
      setEditingDocument(false);
      setCreatingDocument(false);
    } catch (reason) { if (requestId === documentRequest.current) onError(reason instanceof Error ? reason.message : '文档读取失败。'); }
    finally { if (requestId === documentRequest.current) setDocumentsBusy(false); }
  };

  const saveDocument = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!documentTitle.trim()) return;
    setBusy(true);
    try {
      const saved = creatingDocument
        ? await api.post<DocumentRecord>('/knowledge/documents', { title: documentTitle.trim(), content: documentContent, ...(documentScope === 'all' ? {} : { projectId: documentScope }) })
        : await api.patch<DocumentRecord>(`/knowledge/documents/${encodeURIComponent(selectedDocument?.id ?? '')}`, { title: documentTitle.trim(), content: documentContent });
      setSelectedDocument(saved);
      setEditingDocument(false);
      setCreatingDocument(false);
      await reloadDocuments();
      onNotice(creatingDocument ? '文档已创建并完成检索处理。' : '文档已保存，检索片段已同步更新。');
    } catch (reason) { onError(reason instanceof Error ? reason.message : '文档保存失败。'); }
    finally { setBusy(false); }
  };

  const importOffice = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImportBusy(true);
    try {
      const contentBase64 = await fileAsBase64(file);
      const result = await api.post<{ document: DocumentRecord; filename: string; warnings: string[]; stats: Record<string, number> }>('/knowledge/import-file', { filename: file.name, contentBase64, ...(documentScope === 'all' ? {} : { projectId: documentScope }) });
      await reloadDocuments();
      await openDocument(result.document.id);
      const warning = result.warnings.length ? `，有 ${result.warnings.length} 条格式提示` : '';
      onNotice(`${result.filename} 已解析并加入知识库${warning}。`);
    } catch (reason) { onError(reason instanceof Error ? reason.message : '文件导入失败。'); }
    finally { setImportBusy(false); }
  };

  if (!settings) return <LoadingState />;

  return <div className="knowledge-page surface-page">
    <header className="page-header"><div><h1>个人知识库</h1><p>留住有用的资料，让零散的想法慢慢连成线。</p></div><div className="page-header-actions"><input ref={officeInput} className="visually-hidden" type="file" accept=".docx,.xlsx,.pptx,.pdf,.txt,.md,.markdown,.json,.jsonc,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.java,.c,.h,.cpp,.hpp,.cs,.go,.rs,.sql,.yaml,.yml,.toml,.ini,.csv,.xml,.html,.css,.sh,.ps1" onChange={importOffice} /><button className="secondary-button" type="button" disabled={importBusy} onClick={() => officeInput.current?.click()}>{importBusy ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}{importBusy ? '正在解析…' : '上传文件'}</button><button className="primary-button" type="button" onClick={() => { documentRequest.current += 1; setDocumentsBusy(false); setSelectedDocument(null); setDocumentTitle(''); setDocumentContent(''); setCreatingDocument(true); setEditingDocument(true); }}><Plus size={16} />新建文档</button></div></header>
    <section className="subpage-panel knowledge-browser server-knowledge-browser">
      <aside className="knowledge-scope" aria-label="文档范围"><div className="knowledge-scope-heading"><strong>查看范围</strong><span>{documents.length} 篇</span></div><FormSelect label="选择文档范围" value={documentScope} options={[{ value: 'all', label: '全部文档' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} onChange={(value) => { documentRequest.current += 1; setDocumentScope(value); setSelectedDocument(null); setCreatingDocument(false); setEditingDocument(false); }} /><label className="quiet-search knowledge-search"><Search size={16} /><input aria-label="搜索知识库" placeholder="搜索标题、路径或摘要" value={documentQuery} onChange={event => setDocumentQuery(event.target.value)} /></label><div className="knowledge-scope-buttons">{!documentsBusy && !documents.some(document => `${document.title} ${document.relativePath} ${document.excerpt}`.toLocaleLowerCase().includes(documentQuery.trim().toLocaleLowerCase())) ? <p className="knowledge-search-empty">{documents.length ? '没有匹配的文档，试试其他关键词。' : '这里还没有文档。'}</p> : null}{documents.filter(document => `${document.title} ${document.relativePath} ${document.excerpt}`.toLocaleLowerCase().includes(documentQuery.trim().toLocaleLowerCase())).map((document) => <button className={selectedDocument?.id === document.id ? 'active' : ''} type="button" key={document.id} onClick={() => void openDocument(document.id)}><FileText size={16} /><span><strong>{document.title}</strong><small>{formatDateTime(document.serverEditedAt ?? document.modifiedAt)}</small></span></button>)}</div></aside>
      <div className="knowledge-document-pane">
        {editingDocument ? <form className="document-editor" onSubmit={saveDocument}><div className="knowledge-document-heading"><div><h2>{creatingDocument ? '新建文档' : '编辑文档'}</h2><p>记录想法、经验或摘录，保存后即可在对话中引用。</p></div></div><label><span>文档名称</span><input required maxLength={120} value={documentTitle} onChange={(event) => setDocumentTitle(event.target.value)} /></label><label><span>Markdown 内容</span><textarea value={documentContent} onChange={(event) => setDocumentContent(event.target.value)} spellCheck="false" /></label><div className="form-actions"><button className="secondary-button" type="button" onClick={() => { setEditingDocument(false); setCreatingDocument(false); }}>取消</button><button className="primary-button" type="submit" disabled={busy || !documentTitle.trim()}>{busy ? '正在保存…' : '保存文档'}</button></div></form>
        : selectedDocument ? <article className="document-reader"><div className="knowledge-document-heading"><div><h2>{selectedDocument.title}</h2><p>{selectedDocument.sourceType === 'office' ? 'Office 原件解析 · 已加入检索索引' : '解析后的 Markdown'} · 服务器版本 {selectedDocument.serverRevision ?? 1}</p></div><button className="secondary-button" type="button" onClick={() => setEditingDocument(true)}><Pencil size={16} />编辑</button></div><div className="document-reader-content"><MarkdownAnswer content={selectedDocument.content ?? ''} /></div></article>
        : <InlineEmpty icon={<BookOpen size={22} />} title={documentsBusy ? '正在读取文档' : '选择一篇文档'} detail={documents.length ? '在左侧搜索和选择资料，阅读后可以继续编辑。' : '资料库还没有文档，可以新建或等待设备上传。'} />}
      </div>
    </section>
  </div>;

}

function ProjectWorkspace(props: {
  projects: Project[];
  selectedProject: Project | null;
  selectedProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  projectTab: ProjectTab;
  onChangeTab: (tab: ProjectTab) => void;
  tasks: Task[];
  openTasks: Task[];
  doneTasks: Task[];
  documents: DocumentRecord[];
  allTasks: Task[];
  showTaskForm: boolean;
  taskTitle: string;
  onTaskTitleChange: (value: string) => void;
  onShowTaskForm: (show: boolean) => void;
  onCreateTask: (event: React.FormEvent) => void;
  onToggleTask: (task: Task) => void;
  editingTaskId: string | null;
  onEditTask: (id: string | null) => void;
  onUpdateTask: (id: string, changes: Partial<Task>) => Promise<void>;
  onScan: () => void;
  showProjectForm: boolean;
  onShowProjectForm: (show: boolean) => void;
  onProjectsChanged: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  suggestionMode: boolean;
  suggestions: ProjectSuggestion[];
  suggestionError: string | null;
  suggestionJob: LongJobState | null;
  onGenerateSuggestions: () => Promise<void>;
  onSetSuggestions: (suggestions: ProjectSuggestion[]) => void;
  onCloseSuggestions: () => void;
  editingProject: boolean;
  onEditProject: (editing: boolean) => void;
  onUpdateProject: (changes: Partial<Project>) => Promise<void>;
  onDeleteProject: (confirmationName: string) => Promise<void>;
}) {
  const [confirmBusy, setConfirmBusy] = useState(false);

  const confirmSuggestions = async () => {
    const selected = props.suggestions.filter((suggestion) => suggestion.selected && suggestion.name.trim());
    if (!selected.length) return;
    setConfirmBusy(true);
    try {
      const result = await api.post<{ created: Array<{ id: string; name: string }>; skipped: string[] }>('/projects/suggestions/confirm', { suggestions: selected });
      await props.onProjectsChanged();
      props.onCloseSuggestions();
      props.onSetSuggestions([]);
      props.onNotice(`已创建 ${result.created.length} 个项目${result.skipped.length ? `，${result.skipped.length} 个同名项目已跳过` : ''}。`);
    } catch (reason) {
      props.onNotice(reason instanceof Error ? reason.message : '项目创建失败，请稍后重试。');
    } finally {
      setConfirmBusy(false);
    }
  };

  return (
    <div className="project-page">
      {props.suggestionMode ? <>
        <header className="page-header"><div><h1>从资料识别项目</h1><p>模型整理建议后，由你决定是否创建。</p></div></header>
        <ProjectSuggestionReview suggestions={props.suggestions} busy={props.suggestionJob?.status === 'running' || confirmBusy} error={props.suggestionError} job={props.suggestionJob} onChange={props.onSetSuggestions} onRetry={props.onGenerateSuggestions} onCancel={props.onCloseSuggestions} onConfirm={confirmSuggestions} />
      </> : <section className="project-workspace-shell">
        <header className="project-commandbar">
          <div className="project-identity">

            <div className="project-title-row">
              <ProjectSwitcher projects={props.projects} selectedProjectId={props.selectedProjectId} onSelect={props.onSelectProject} />
              {props.selectedProject ? <><AppIconButton label="管理当前项目" onClick={() => props.onEditProject(true)}><Pencil size={17} /></AppIconButton><span className={`status-label status-${props.selectedProject.status}`}>{projectStatusLabel[props.selectedProject.status]}</span></> : null}
            </div>
            {props.selectedProject ? <div className="project-progress-summary"><span>项目进度</span><strong>{props.selectedProject.progress}%</strong><div><i style={{ width: `${props.selectedProject.progress}%` }} /></div></div> : <p className="project-overview-copy">每个项目都有清晰的进度，也有可以着手的下一步。</p>}
          </div>
          <div className="project-command-actions">
            <button className="secondary-button" type="button" disabled={props.suggestionJob?.status === 'running'} onClick={props.onGenerateSuggestions}><Sparkles size={16} />{props.suggestionJob?.status === 'running' ? '正在识别…' : '从资料识别项目'}</button>
            <button className="primary-button" type="button" onClick={() => props.onShowProjectForm(true)}><Plus size={17} />新建项目</button>
          </div>
        </header>
        {props.selectedProject ? <nav className="project-section-tabs" role="tablist" aria-label="项目内容">
          {([['tasks', `项目任务 ${props.tasks.length}`], ['documents', `项目文档 ${props.documents.length}`]] as const).map(([value, label]) => (
            <button role="tab" aria-selected={props.projectTab === value} type="button" key={value} onClick={() => props.onChangeTab(value)}>{label}</button>
          ))}
        </nav> : null}
        <div className="project-content-area">
          {!props.selectedProject ? <ProjectDirectory projects={props.projects} tasks={props.allTasks} onSelect={props.onSelectProject} /> : null}
          {props.selectedProject && props.projectTab === 'tasks' ? <TasksTab tasks={props.tasks} openTasks={props.openTasks} doneTasks={props.doneTasks} documents={props.documents} showForm={props.showTaskForm} title={props.taskTitle} onTitleChange={props.onTaskTitleChange} onShowForm={props.onShowTaskForm} onCreate={props.onCreateTask} onToggle={props.onToggleTask} editingTaskId={props.editingTaskId} onEdit={props.onEditTask} onUpdate={props.onUpdateTask} /> : null}
          {props.selectedProject && props.projectTab === 'documents' ? <DocumentsTab projectId={props.selectedProject.id} documents={props.documents} onRefresh={props.onRefresh} onNotice={props.onNotice} onError={props.onError} /> : null}
        </div>
      </section>}
      {props.showProjectForm ? <NewProjectModal onCancel={() => props.onShowProjectForm(false)} onCreated={async () => { props.onShowProjectForm(false); await props.onProjectsChanged(); }} /> : null}
      {props.editingProject && props.selectedProject ? <ProjectSettingsModal project={props.selectedProject} onCancel={() => props.onEditProject(false)} onSave={props.onUpdateProject} onDelete={props.onDeleteProject} /> : null}
    </div>
  );
}

function ProjectSuggestionReview({ suggestions, busy, error, job, onChange, onRetry, onCancel, onConfirm }: {
  suggestions: ProjectSuggestion[];
  busy: boolean;
  error: string | null;
  job: LongJobState | null;
  onChange: (suggestions: ProjectSuggestion[]) => void;
  onRetry: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const selectedCount = suggestions.filter((suggestion) => suggestion.selected && suggestion.name.trim()).length;
  const update = (id: string, changes: Partial<ProjectSuggestion>) => onChange(suggestions.map((suggestion) => suggestion.id === id ? { ...suggestion, ...changes } : suggestion));

  if (busy && !suggestions.length) return <section className="project-recognition" aria-label="项目识别进度">
    <div className="recognition-overview">
      <div className="recognition-art" aria-hidden="true"><FileText className="recognition-sheet back" size={44} /><FileText className="recognition-sheet front" size={44} /><span><Sparkles size={22} /></span></div>
      <h2>正在整理你的工作项目</h2>
      <p>从零散资料中梳理项目线索，<br />整理好后，由你决定是否创建。</p>
      <div className="recognition-status" role="status"><LoaderCircle className="spin" size={16} /><span>{job?.stage === 'analyzing' ? '正在关联资料，整理项目建议' : job?.stage === 'reading' ? '正在读取资料' : '正在查找资料'}</span></div>
      {job && job.total > 0 ? <div className="recognition-count">已处理 <strong>{job.current}</strong><span> / {job.total} 篇资料</span></div> : null}
    </div>
    <div className="recognition-process"><h3>识别进度</h3>{job ? <LongJobDetail job={job} /> : <p role="status">正在准备识别任务…</p>}</div>
    <footer className="recognition-footer"><span><ShieldCheck size={16} />不会修改 Obsidian 文件</span><button className="text-button" type="button" onClick={onCancel}>返回项目列表，后台继续<ChevronRight size={15} /></button></footer>
  </section>;

  if (error) return <section className="suggestion-problem" role="alert"><AlertTriangle size={22} /><div><h2>这次没有识别成功</h2><p>{error}</p><div className="suggestion-problem-actions"><button className="secondary-button" type="button" onClick={onCancel}>返回项目列表</button><button className="primary-button" type="button" onClick={onRetry}>重新识别</button></div></div></section>;

  return <section className="suggestion-review">
    <div className="suggestion-review-heading">
      <div><h2>{suggestions.length ? `模型建议添加 ${suggestions.length} 个项目` : '没有发现新的项目'}</h2><p>{suggestions.length ? '已经默认全选。你可以取消不需要的项目，或直接修改名称和目标。' : '现有项目可能已经覆盖了资料内容，也可能需要补充更明确的项目文档。'}</p></div>
      <button className="secondary-button" type="button" onClick={onCancel}>返回项目列表</button>
    </div>
    {suggestions.length ? <>
      <div className="suggestion-toolbar">
        <span>建议项目</span>
        <button className="text-button" type="button" onClick={() => onChange(suggestions.map((suggestion) => ({ ...suggestion, selected: selectedCount !== suggestions.length })))}>{selectedCount === suggestions.length ? '全部取消' : '全部选择'}</button>
      </div>
      <div className="suggestion-list">
        {suggestions.map((suggestion) => <article className={suggestion.selected ? 'suggestion-row selected' : 'suggestion-row'} key={suggestion.id}>
          <label className="suggestion-check"><input type="checkbox" checked={suggestion.selected} onChange={(event) => update(suggestion.id, { selected: event.target.checked })} /><span aria-hidden="true"><Check size={14} /></span><span className="sr-only">选择 {suggestion.name}</span></label>
          <div className="suggestion-fields">
            <input aria-label="项目名称" maxLength={80} value={suggestion.name} disabled={!suggestion.selected || busy} onChange={(event) => update(suggestion.id, { name: event.target.value })} />
            <input aria-label="项目目标" maxLength={500} value={suggestion.summary} disabled={!suggestion.selected || busy} onChange={(event) => update(suggestion.id, { summary: event.target.value })} placeholder="补充一句话项目目标" />
            <div className="suggestion-evidence"><span>{suggestion.reason}</span><span>{suggestion.documentCount} 篇相关文档{suggestion.sourcePath ? ` · ${suggestion.sourcePath}` : ''}</span></div>
          </div>
        </article>)}
      </div>
      <footer className="suggestion-confirm-bar"><span>将创建 <strong>{selectedCount}</strong> 个项目</span><button className="primary-button" type="button" disabled={busy || selectedCount === 0} onClick={onConfirm}>{busy ? '正在创建…' : `确认创建 ${selectedCount} 个项目`}</button></footer>
    </> : <div className="empty-state standalone-empty"><Sparkles size={25} /><h2>暂时不用添加</h2><p>你可以返回项目列表，或稍后更新资料后再识别。</p><button className="secondary-button" type="button" onClick={onRetry}>重新识别</button></div>}
  </section>;
}

function TrashWorkspace({ projects, onRestore }: { projects: Project[]; onRestore: (id: string) => void }) {
  return <div className="trash-page surface-page">
    <header className="page-header">
      <div><h1>项目回收站</h1><p>误删的项目可以在这里恢复，任务、对话、记忆和资料关联都会保留。</p></div>
      <span className="trash-total">{projects.length} 个项目</span>
    </header>
    {projects.length ? <section className="trash-list-card" aria-label="已删除项目">
      {projects.map((project) => <div className="trash-row" key={project.id}>
        <div className="trash-row-icon"><Trash2 size={18} /></div>
        <div className="trash-row-content"><strong>{project.name}</strong><span>{project.deletedAt ? `${formatDateTime(project.deletedAt)} 移入回收站` : '已移入回收站'}</span></div>
        <button className="secondary-button" type="button" onClick={() => onRestore(project.id)}><RotateCcw size={15} />恢复项目</button>
      </div>)}
    </section> : <div className="empty-state standalone-empty"><Trash2 size={25} /><h2>回收站是空的</h2><p>移入回收站的项目会显示在这里。</p></div>}
  </div>;
}

function NewProjectModal({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return <dialog ref={dialogRef} className="project-settings-dialog new-project-dialog" aria-labelledby="new-project-title" onCancel={(event) => { event.preventDefault(); onCancel(); }} onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}><div className="project-settings-modal-body"><NewProjectForm onCancel={onCancel} onCreated={onCreated} /></div></dialog>;
}

function NewProjectForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/projects', { name, summary, priority: 'medium' });
      await onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '项目创建失败。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form project-form" onSubmit={submit}>
      <div className="form-heading"><div><h2 id="new-project-title">新建项目</h2><p>先填写名称和目标，文档可以稍后手动关联。</p></div><AppIconButton label="取消新建项目" onClick={onCancel}><X size={17} /></AppIconButton></div>
      <label><span>项目名称</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：AI 秘书" /></label>
      <label><span>一句话目标</span><input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="这个项目要解决什么？" /></label>
      {error ? <FeedbackBanner tone="error">{error}</FeedbackBanner> : null}
      <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy ? '正在创建…' : '创建项目'}</button></div>
    </form>
  );
}

function ProjectSettingsModal({ project, onCancel, onSave, onDelete }: { project: Project; onCancel: () => void; onSave: (changes: Partial<Project>) => Promise<void>; onDelete: (confirmationName: string) => Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="project-settings-dialog"
      aria-labelledby="project-settings-title"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div className="project-settings-modal-body">
        <ProjectSettingsForm project={project} onCancel={onCancel} onSave={onSave} onDelete={onDelete} />
      </div>
    </dialog>
  );
}

function ProjectSettingsForm({ project, onCancel, onSave, onDelete }: { project: Project; onCancel: () => void; onSave: (changes: Partial<Project>) => Promise<void>; onDelete: (confirmationName: string) => Promise<void> }) {
  const [name, setName] = useState(project.name);
  const [summary, setSummary] = useState(project.summary);
  const [status, setStatus] = useState<Project['status']>(project.status);
  const [priority, setPriority] = useState<Priority>(project.priority);
  const [progress, setProgress] = useState(project.progress);
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteName, setDeleteName] = useState('');

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onSave({ name, summary, status, priority, progress });
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    try {
      await onSave({ status: 'archived' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await onDelete(deleteName);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="inline-form project-settings-form" onSubmit={save}>
      <div className="form-heading"><div><h2 id="project-settings-title">管理项目</h2><p>编辑项目目标、状态和当前进度。</p></div><AppIconButton label="关闭项目管理" onClick={onCancel}><X size={17} /></AppIconButton></div>
      <label><span>项目名称</span><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <div className="form-field"><span>项目状态</span><FormSelect label="项目状态" value={status} options={projectStatusOptions} onChange={setStatus} /></div>
      <div className="form-field"><span>优先级</span><FormSelect label="优先级" value={priority} options={priorityOptions} onChange={setPriority} /></div>
      <label><span>项目进度（%）</span><input type="number" min="0" max="100" value={progress} onChange={(event) => setProgress(Math.max(0, Math.min(100, Number(event.target.value))))} /></label>
      <label className="wide-field"><span>一句话目标</span><textarea maxLength={500} value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
      <div className="archive-zone">
        {confirmArchive ? <div className="inline-confirm"><span>归档后项目仍保留，Obsidian 文档不会被删除。</span><button className="danger-button" type="button" disabled={busy} onClick={archive}>确认归档</button><button className="secondary-button" type="button" onClick={() => setConfirmArchive(false)}>取消</button></div> : <button className="text-danger-button" type="button" disabled={project.status === 'archived'} onClick={() => setConfirmArchive(true)}><Archive size={16} />{project.status === 'archived' ? '项目已归档' : '归档项目'}</button>}
      </div>
      <div className="delete-zone">
        {confirmDelete ? <div className="delete-confirm">
          <div><strong>移入回收站</strong><p>任务、对话和记忆会保留，Obsidian 文档不会被修改。请输入“{project.name}”确认。</p></div>
          <input aria-label="输入项目名称确认删除" value={deleteName} onChange={(event) => setDeleteName(event.target.value)} placeholder={project.name} />
          <div className="delete-confirm-actions"><button className="danger-button" type="button" disabled={busy || deleteName !== project.name} onClick={remove}>确认移入回收站</button><button className="secondary-button" type="button" onClick={() => { setConfirmDelete(false); setDeleteName(''); }}>取消</button></div>
        </div> : <button className="text-danger-button" type="button" onClick={() => setConfirmDelete(true)}><Trash2 size={16} />移入回收站</button>}
      </div>
      <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel}>取消</button><button className="primary-button" type="submit" disabled={busy || !name.trim()}>{busy ? '正在保存…' : '保存项目'}</button></div>
    </form>
  );
}


function ProjectDirectory({ projects, tasks, onSelect }: { projects: Project[]; tasks: Task[]; onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState('active');
  const [query, setQuery] = useState('');
  const visible = projects.filter(project => (filter === 'all' || project.status === filter) && `${project.name} ${project.summary}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="project-directory"><div className="focus-toolbar"><label className="quiet-search"><Search size={17} /><input aria-label="搜索项目" placeholder="搜索项目" value={query} onChange={event => setQuery(event.target.value)} /></label><FormSelect label="项目状态筛选" value={filter} options={[{ value: 'all', label: '全部状态' }, ...projectStatusOptions]} onChange={setFilter} /></div>
    <div className="project-directory-list">{visible.map(project => { const next = sortActionTasks(tasks.filter(task => task.projectId === project.id && task.status !== 'done' && task.status !== 'cancelled'))[0]; return <button className="project-directory-row" key={project.id} onClick={() => onSelect(project.id)}><div className="project-directory-copy"><div><h2>{project.name}</h2><span className={`status-label status-${project.status}`}>{projectStatusLabel[project.status]}</span></div><p>{project.summary || '为这个项目写下目标，让每一步都有方向。'}</p><small>{next ? `下一步 · ${next.title}` : '暂无待办，进入项目记录下一步'} </small></div><div className="directory-progress"><strong>{project.progress}%</strong><progress aria-label={`${project.name}进度`} max={100} value={project.progress} /><span>{project.taskCounts.open} 项待办 · {project.documentCount} 篇资料</span></div><ChevronRight size={18} /></button>; })}</div>
    {!visible.length && <InlineEmpty icon={<FolderKanban size={24} />} title={projects.length ? '没有符合条件的项目' : '从一个小目标开始'} detail={projects.length ? '切换项目状态或搜索关键词。' : '新建项目，添加待办，再把相关资料放进来。'} />}
  </div>;
}

function TasksTab(props: { tasks: Task[]; openTasks: Task[]; doneTasks: Task[]; documents: DocumentRecord[]; showForm: boolean; title: string; onTitleChange: (value: string) => void; onShowForm: (show: boolean) => void; onCreate: (event: React.FormEvent) => void; onToggle: (task: Task) => void; editingTaskId: string | null; onEdit: (id: string | null) => void; onUpdate: (id: string, changes: Partial<Task>) => Promise<void> }) {
  const [showCompleted, setShowCompleted] = useState(false);
  const openTasks = useMemo(() => sortActionTasks(props.openTasks), [props.openTasks]);
  const doneTasks = useMemo(() => sortTasksByStartDesc(props.doneTasks), [props.doneTasks]);
  const orderedTasks = showCompleted ? [...openTasks, ...doneTasks] : openTasks;
  return (
    <div className="tab-panel project-tab-panel">
      <div className="section-heading task-heading"><div><h3>项目任务</h3><p>{openTasks.length} 个未完成，{doneTasks.length} 个已完成；优先显示临近截止的任务。</p></div><div className="task-heading-actions">{doneTasks.length ? <button className="secondary-button" type="button" aria-pressed={showCompleted} onClick={() => setShowCompleted((current) => !current)}>{showCompleted ? '隐藏已完成' : '展示已完成'}</button> : null}<button className="primary-button" type="button" onClick={() => props.onShowForm(true)}><Plus size={16} />新建任务</button></div></div>
      {props.showForm ? <form className="quick-task" onSubmit={props.onCreate}><input aria-label="新任务名称" required maxLength={120} name="task-title" value={props.title} onChange={(event) => props.onTitleChange(event.target.value)} placeholder="输入任务名称" /><button className="primary-button" type="submit">创建</button><button className="secondary-button" type="button" onClick={() => props.onShowForm(false)}>取消</button></form> : null}
      {orderedTasks.length ? <div className="project-task-table" role="table" aria-label="项目任务列表">
        <div className="task-table-head" role="row"><span role="columnheader">任务名称</span><span role="columnheader">完成状态</span><span role="columnheader">开始时间</span><span role="columnheader">截止 / 完成</span><span role="columnheader" className="sr-only">操作</span></div>
        {orderedTasks.map((task) => <div className="task-table-entry" key={task.id}>
          <div className={`task-table-row ${task.status === 'done' ? 'done' : ''}`} role="row">
            <div className="task-name-cell" role="cell" data-label="任务名称"><button className="task-check" type="button" onClick={() => props.onToggle(task)} aria-label={task.status === 'done' ? `重新打开任务：${task.title}` : `完成任务：${task.title}`}>{task.status === 'done' ? <Check size={15} /> : <Circle size={15} />}</button><strong>{task.title}</strong></div>
            <span className={`task-status-cell status-${task.status}`} role="cell" data-label="完成状态">{statusLabel[task.status]}</span>
            <time role="cell" data-label="开始时间">{formatDateOnly(task.startAt ?? task.createdAt)}</time>
            <time role="cell" data-label="截止 / 完成">{formatDateOnly(task.status === 'done' ? task.completedAt : task.dueAt)}</time>
            <AppIconButton label={`编辑任务：${task.title}`} onClick={() => props.onEdit(props.editingTaskId === task.id ? null : task.id)}><Pencil size={16} /></AppIconButton>
          </div>
          {props.editingTaskId === task.id ? <TaskEditForm task={task} documents={props.documents} onCancel={() => props.onEdit(null)} onSave={props.onUpdate} /> : null}
        </div>)}
      </div> : <InlineEmpty icon={<Check size={20} />} title={doneTasks.length ? '没有未完成任务' : '还没有项目任务'} detail={doneTasks.length ? '点击“展示已完成”查看已经完成的任务。' : '新建第一个任务，把项目下一步放进来。'} />}
    </div>
  );
}

function TaskEditForm({ task, documents, onCancel, onSave }: { task: Task; documents: DocumentRecord[]; onCancel: () => void; onSave: (id: string, changes: Partial<Task>) => Promise<void> }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [executor, setExecutor] = useState<Task['executor']>(task.executor);
  const [dueAt, setDueAt] = useState(task.dueAt?.slice(0, 10) ?? '');
  const [blockedReason, setBlockedReason] = useState(task.blockedReason ?? '');
  const [documentIds, setDocumentIds] = useState(task.relatedDocuments.map((document) => document.id));
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    try {
      await onSave(task.id, { title, description, status, priority, executor, dueAt: dueAt || null, blockedReason, documentIds } as Partial<Task>);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="task-edit-form" onSubmit={submit}>
      <label className="wide-field"><span>任务名称</span><input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <div className="form-field"><span>状态</span><FormSelect label="任务状态" value={status} options={taskStatusOptions} onChange={setStatus} /></div>
      <div className="form-field"><span>优先级</span><FormSelect label="任务优先级" value={priority} options={priorityOptions} onChange={setPriority} /></div>
      <div className="form-field"><span>执行方</span><FormSelect label="任务执行方" value={executor} options={taskExecutorOptions} onChange={setExecutor} /></div>
      <label><span>截止时间</span><DatePicker label="截止日期" value={dueAt} onChange={setDueAt} /></label>
      <label className="wide-field"><span>任务说明</span><textarea maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="补充目标、验收要求或等待事项…" /></label>
      <label className="wide-field"><span>阻塞原因</span><input maxLength={500} value={blockedReason} onChange={(event) => setBlockedReason(event.target.value)} placeholder="如：等待接口、依赖外部确认；没有可留空" /></label>
      <fieldset className="wide-field document-link-field"><legend>相关文档（可多选）</legend>{documents.map((document) => <label key={document.id}><input type="checkbox" checked={documentIds.includes(document.id)} onChange={(event) => setDocumentIds((current) => event.target.checked ? [...current, document.id] : current.filter((id) => id !== document.id))} /><span>{document.title}</span></label>)}</fieldset>
      <div className="form-actions wide-field"><button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>取消</button><button className="primary-button" type="submit" disabled={busy || !title.trim()}>{busy ? '正在保存…' : '保存任务'}</button></div>
    </form>
  );
}

function ProjectDocumentDialog({ mode, projectId, linkedDocuments, onClose, onSaved, onNotice, onError }: {
  mode: 'link' | 'create';
  projectId: string;
  linkedDocuments: DocumentRecord[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(mode === 'link');
  const [busy, setBusy] = useState(false);
  const linkedIds = useMemo(() => new Set(linkedDocuments.map((document) => document.id)), [linkedDocuments]);

  useEffect(() => {
    dialogRef.current?.showModal();
    if (mode !== 'link') return;
    let active = true;
    api.get<DocumentRecord[]>('/knowledge/documents')
      .then((result) => {
        if (!active) return;
        setDocuments(result);
        setSelectedIds(result.filter((document) => linkedIds.has(document.id)).map((document) => document.id));
      })
      .catch((reason) => onError(reason instanceof Error ? reason.message : '文档列表读取失败，请稍后重试。'))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [linkedIds, mode, onError]);

  const visibleDocuments = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('zh-CN');
    return keyword ? documents.filter((document) => document.title.toLocaleLowerCase('zh-CN').includes(keyword)) : documents;
  }, [documents, query]);
  const newSelections = selectedIds.filter((id) => !linkedIds.has(id));

  const linkDocuments = async () => {
    if (!newSelections.length) return;
    setBusy(true);
    try {
      await Promise.all(newSelections.map((documentId) => api.put(`/projects/${projectId}/documents/${documentId}`, {})));
      await onSaved();
      onNotice(`已关联 ${newSelections.length} 篇文档。`);
      onClose();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '文档关联失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  const createDocument = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setBusy(true);
    try {
      await api.post<DocumentRecord>('/knowledge/documents', { title: title.trim(), content, projectId });
      await onSaved();
      onNotice('文档已保存到服务器并关联当前项目。');
      onClose();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '文档保存失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  return <dialog
    ref={dialogRef}
    className="project-document-dialog"
    aria-labelledby="project-document-dialog-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
  >
    <div className="project-document-modal">
      <header>
        <div><h2 id="project-document-dialog-title">{mode === 'link' ? '关联文档' : '新增文档'}</h2><p>{mode === 'link' ? '选择服务器资料库中的文档，文档可以同时关联多个项目。' : '使用 Markdown 编写，保存后将进入服务器资料库并关联当前项目。'}</p></div>
        <AppIconButton label="关闭弹窗" disabled={busy} onClick={onClose}><X size={18} /></AppIconButton>
      </header>
      {mode === 'link' ? <>
        <div className="project-document-search"><Search size={17} aria-hidden="true" /><label className="sr-only" htmlFor="project-document-search">搜索文档</label><input id="project-document-search" name="document-search" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文档…" /></div>
        <div className="project-document-picker" aria-busy={loading}>
          {loading ? <div className="document-dialog-state"><LoaderCircle className="spin" size={20} />正在读取文档…</div> : visibleDocuments.map((document) => {
            const alreadyLinked = linkedIds.has(document.id);
            return <label className={alreadyLinked ? 'is-linked' : ''} key={document.id}>
              <input type="checkbox" checked={selectedIds.includes(document.id)} disabled={alreadyLinked || busy} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, document.id] : current.filter((id) => id !== document.id))} />
              <FileText size={17} aria-hidden="true" />
              <span><strong>{document.title}</strong><small>{formatDateTime(document.serverEditedAt ?? document.modifiedAt)}</small></span>
              {alreadyLinked ? <em>已关联</em> : null}
            </label>;
          })}
          {!loading && visibleDocuments.length === 0 ? <div className="document-dialog-state"><BookOpen size={21} /><strong>{query ? '没有匹配的文档' : '资料库中还没有文档'}</strong></div> : null}
        </div>
        <footer><span>{newSelections.length ? `已选择 ${newSelections.length} 篇新文档` : '请选择要关联的文档'}</span><div><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" type="button" disabled={busy || !newSelections.length} onClick={() => void linkDocuments()}>{busy ? '正在关联…' : '关联'}</button></div></footer>
      </> : <form className="project-document-editor" onSubmit={createDocument}>
        <label><span>标题</span><input name="document-title" autoComplete="off" required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="输入文档标题…" /></label>
        <label className="document-body-field"><span>正文（Markdown）</span><textarea name="document-content" required value={content} onChange={(event) => setContent(event.target.value)} placeholder="开始编写 Markdown 文档…" /></label>
        <footer><span>文档只保存在服务器，不会写回 Obsidian。</span><div><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={busy || !title.trim() || !content.trim()}>{busy ? '正在保存…' : '保存并关联'}</button></div></footer>
      </form>}
    </div>
  </dialog>;
}

function RecordDialog({ title, busy = false, onClose, children, wide = false }: { title: string; busy?: boolean; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className={`record-dialog${wide ? ' record-reader-dialog' : ''}`} aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <header><h2>{title}</h2><button type="button" className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={19} /></button></header>
    <div className="record-dialog-body">{children}</div>
  </dialog>;
}

function ProjectDocumentReader({ document, onClose }: { document: DocumentRecord; onClose: () => void }) {
  const [loaded, setLoaded] = useState<DocumentRecord | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(''); setLoaded(null);
    api.get<DocumentRecord>(`/knowledge/documents/${encodeURIComponent(document.id)}`)
      .then(result => { if (active) setLoaded(result); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '文档读取失败。'); });
    return () => { active = false; };
  }, [document.id, attempt]);
  return <RecordDialog title={loaded?.title ?? document.title} wide onClose={onClose}>
    {error ? <FeedbackBanner tone="error" action={<button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新读取</button>}>{error}</FeedbackBanner> : !loaded ? <p role="status"><LoaderCircle className="spin" size={18} />正在读取文档…</p> : <><p className="record-source">{loaded.relativePath}</p>{loaded.content?.trim() ? <MarkdownAnswer content={loaded.content} /> : <p>这篇文档暂时没有正文。</p>}</>}
  </RecordDialog>;
}

function QuickTaskEditor({ task, onClose, onSave }: { task: Task; onClose: () => void; onSave: (id: string, changes: Partial<Task>) => Promise<void> }) {
  const [documents, setDocuments] = useState<DocumentRecord[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    setError('');
    api.get<DocumentRecord[]>('/knowledge/documents').then(result => { if (active) setDocuments(result); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '任务资料加载失败。'); });
    return () => { active = false; };
  }, [task.id, attempt]);
  return <RecordDialog title="编辑任务" busy={saving} onClose={onClose}>
    {error ? <FeedbackBanner tone="error">{error}</FeedbackBanner> : null}
    {!documents ? error ? <button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新加载</button> : <p role="status">正在加载任务资料…</p> : <TaskEditForm task={task} documents={documents} onCancel={onClose} onSave={async (id, changes) => {
      setSaving(true); setError('');
      try { await onSave(id, changes); onClose(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试。'); }
      finally { setSaving(false); }
    }} />}
  </RecordDialog>;
}

function DocumentsTab({ projectId, documents, onRefresh, onNotice, onError }: { projectId: string; documents: DocumentRecord[]; onRefresh: () => Promise<void>; onNotice: (message: string) => void; onError: (message: string) => void }) {
  const [readingDocument, setReadingDocument] = useState<DocumentRecord | null>(null);
  const [dialog, setDialog] = useState<'link' | 'create' | null>(null);
  const [unlinkDocument, setUnlinkDocument] = useState<DocumentRecord | null>(null);
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const unlinkDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (unlinkDocument) unlinkDialogRef.current?.showModal(); }, [unlinkDocument]);
  const confirmUnlink = async () => {
    if (!unlinkDocument) return;
    setUnlinkBusy(true);
    try {
      await api.delete(`/projects/${projectId}/documents/${unlinkDocument.id}`);
      await onRefresh();
      onNotice(`已取消关联“${unlinkDocument.title}”。`);
      setUnlinkDocument(null);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '取消关联失败，请稍后重试。');
    } finally {
      setUnlinkBusy(false);
    }
  };
  return (
    <div className="tab-panel">
      <div className="section-heading project-documents-heading"><div><h3>项目文档</h3><p>文档统一保存在服务器；不会写回任意设备的 Obsidian。</p></div><div><button className="secondary-button" type="button" onClick={() => setDialog('link')}><Paperclip size={16} />关联文档</button><button className="primary-button" type="button" onClick={() => setDialog('create')}><Plus size={16} />新增文档</button></div></div>
      <div className="document-list">
        {documents.map((document) => <article className="document-row project-document-row" key={document.id}><FileText size={18} /><div><button type="button" className="inline-record-link" onClick={() => setReadingDocument(document)} aria-label={`查看文档：${document.title}`}><strong>{document.title}</strong><span className="record-action-hint">查看</span></button></div><time>{formatDateTime(document.serverEditedAt ?? document.modifiedAt)}</time><button className="document-unlink-button" type="button" onClick={() => setUnlinkDocument(document)}>取消关联</button></article>)}
        {documents.length === 0 ? <InlineEmpty icon={<BookOpen size={21} />} title="当前项目还没有文档" detail="关联资料库中的已有文档，或直接新增一篇 Markdown 文档。" /> : null}
      </div>
      {dialog ? <ProjectDocumentDialog mode={dialog} projectId={projectId} linkedDocuments={documents} onClose={() => setDialog(null)} onSaved={onRefresh} onNotice={onNotice} onError={onError} /> : null}
      {readingDocument ? <ProjectDocumentReader key={readingDocument.id} document={readingDocument} onClose={() => setReadingDocument(null)} /> : null}
      {unlinkDocument ? <dialog ref={unlinkDialogRef} className="document-unlink-dialog" aria-labelledby="document-unlink-title" onCancel={(event) => { event.preventDefault(); if (!unlinkBusy) setUnlinkDocument(null); }} onClick={(event) => { if (event.target === event.currentTarget && !unlinkBusy) setUnlinkDocument(null); }}>
        <div className="document-unlink-modal">
          <AlertTriangle size={25} aria-hidden="true" />
          <div><h2 id="document-unlink-title">确认取消关联？</h2><p>文档“{unlinkDocument.title}”将不再出现在当前项目中。</p><strong>服务器资料库中的文档不会被删除，也不会影响它与其他项目的关联。</strong></div>
          <footer><button className="secondary-button" type="button" disabled={unlinkBusy} onClick={() => setUnlinkDocument(null)}>保留关联</button><button className="danger-button" type="button" disabled={unlinkBusy} onClick={() => void confirmUnlink()}>{unlinkBusy ? '正在取消…' : '确认取消关联'}</button></footer>
        </div>
      </dialog> : null}
    </div>
  );
}


function InlineEmpty({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return <div className="inline-empty">{icon}<div><strong>{title}</strong><p>{detail}</p></div></div>;
}
