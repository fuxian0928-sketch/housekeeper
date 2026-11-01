export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';
export type TaskStatus = 'todo' | 'doing' | 'waiting' | 'done' | 'cancelled';
export type Priority = 'high' | 'medium' | 'low';

export interface Project {
  id: string;
  name: string;
  summary: string;
  status: ProjectStatus;
  priority: Priority;
  vaultPath: string;
  sourcePath: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  taskCounts: { open: number; done: number };
  documentCount: number;
  memoryCount: number;
  progress: number;
}

export interface ProjectSuggestion {
  id: string;
  name: string;
  summary: string;
  reason: string;
  sourcePath: string;
  documentPaths: string[];
  documentCount: number;
  selected: boolean;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  executor: 'self' | 'ai' | 'external';
  dueAt: string | null;
  sourceLabel: string;
  dependsOn: string[];
  blockedReason: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startAt: string | null;
  relatedDocuments: Array<{ id: string; title: string }>;
}

export interface DocumentRecord {
  id: string;
  relativePath: string;
  title: string;
  excerpt: string;
  bytes: number;
  modifiedAt: string;
  indexedAt: string;
  content?: string;
  sourceType?: 'obsidian' | 'server' | 'office' | 'upload';
  serverRevision?: number;
  serverEditedAt?: string | null;
  projectIds?: string[];
  taskIds?: string[];
}

export interface EventRecord {
  id: string;
  eventType: string;
  title: string;
  detail: string;
  createdAt: string;
}

export interface ProjectSummary {
  headline: string;
  narrative: string;
  progress: string;
  risks: Array<{ severity: 'high' | 'medium' | 'low'; title: string; detail: string }>;
  nextActions: Array<{ taskId: string | null; title: string; reason: string }>;
  currentStage?: string;
  completedResults?: Array<{ title: string; source: string }>;
  recentChanges?: Array<{ event_type: string; title: string; detail: string; created_at: string }>;
  informationGaps?: string[];
  coverage?: { documentCount: number; branchCount: number; branches: string[]; citedDocumentCount: number };
  evidence: Array<{ type: 'document' | 'memory' | 'task'; title: string; source: string }>;
  mode: 'local' | 'openai';
  model: string | null;
  generatedAt: string;
}

export interface ProjectSummaryVersion {
  id: string;
  summary: ProjectSummary;
  coverage: ProjectSummary['coverage'];
  model: string | null;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  projectId: string | null;
  projectName: string | null;
  content: string;
  memoryType: string;
  status: 'candidate' | 'confirmed' | 'superseded' | 'invalidated' | 'rejected';
  sourceLabel: string;
  sourceType?: string;
  sourceExcerpt?: string | null;
  origin?: 'manual' | 'automatic' | string;
  reason?: string;
  confidence?: number;
  importance?: number;
  evidenceCount?: number;
  tags?: string[];
  lastVerifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryProjectOverview {
  projectId: string;
  projectName: string;
  memoryCount: number;
  summary: string;
  updatedAt: string | null;
}

export interface MemoryOverview {
  totalCount: number;
  projectSummaries: MemoryProjectOverview[];
  personalSummary: {
    summary: string;
    memoryCount: number;
    updatedAt: string | null;
  };
  generatedAt: string;
}

export interface ChatCitation {
  document: string;
  path: string;
  excerpt: string;
  documentId?: string;
  version?: number;
  parentId?: string;
  sourceRevision?: string;
  locator?: {startLine: number; endLine: number; page?: number; slide?: number; sheet?: string; rowStart?: number; rowEnd?: number; symbol?: string; jsonPath?: string};
}

export interface MemorySuggestion {
  content: string;
  projectId: string | null;
  memoryType: string;
  sourceLabel: string;
}

export interface TaskSuggestion {
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  executor: Task['executor'];
  dueAt: string | null;
  sourceLabel: string;
}

export interface TaskBatchSuggestion {
  projectId: string;
  tasks: TaskSuggestion[];
}

export interface ChatMessage {
  id?: string;
  runId?: string | null;
  runStatus?: import('./features/agent/types').RunStatus;
  role: 'user' | 'assistant';
  content: string;
  citations?: ChatCitation[];
  memorySuggestion?: MemorySuggestion | null;
  taskSuggestion?: TaskSuggestion | null;
  taskBatchSuggestion?: TaskBatchSuggestion | null;
  suggestionId?: string | null;
  suggestionSaved?: boolean;
  analysisSteps?: ChatAnalysisStep[];
  createdAt?: string;
  clientKey?: string;
}

export interface ChatAnalysisStep {
  id: string;
  label: string;
  status: 'active' | 'done' | 'warning';
  detail?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  scope: 'project' | 'memory';
  projectId: string | null;
  projectName?: string | null;
  compressedAt?: string | null;
  messageCount: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

export interface StoredConversation {
  channel?:'voice'|'text';
  businessProjectId?:string|null;
  id: string;
  title: string;
  scope: 'project' | 'memory';
  projectId: string | null;
  compressedAt?: string | null;
  messages: ChatMessage[];
}

export interface AppSettings {
  speechExecution?: 'local' | 'cloud';
  provider: 'openai-compatible';
  aiEnabled: boolean;
  model: string;
  visionModel: string;
  visionApiBaseUrl?:string;
  hasVisionApiKey?:boolean;
  visionApiKeySource?:'session'|'device'|'environment'|'fallback'|'none';
  voiceWebSearchEnabled?:boolean;
  speechRecognitionModel: string;
  speechRealtimeRecognitionModel?: string;
  speechRealtimeSynthesisModel?: string;
  speechRealtimeSynthesisBaseUrl?: string;
  speechRealtimeVoice?: string;

  speechSynthesisModel: string;
  speechServiceBaseUrl: string;
  speechLegacyRecognitionBaseUrl?: string;
  speechLegacySynthesisBaseUrl?: string;
  speechVoice: string;
  speechInstruction: string;
  apiBaseUrl: string;
  retrievalApiBaseUrl: string;
  reasoningEffort: 'auto' | 'low' | 'medium' | 'high';
  embeddingModel: string;
  rerankerModel: string;
  hasApiKey: boolean;
  apiKeySource: 'none' | 'session' | 'device' | 'environment';
  hasRetrievalApiKey: boolean;
  retrievalApiKeySource: 'none' | 'session' | 'device' | 'environment' | 'fallback';
  webSearchPolicy: 'off' | 'ask' | 'auto';
  hasWebSearchApiKey: boolean;
  webSearchApiKeySource: 'none' | 'session' | 'device' | 'environment' | 'model';
  webSearchProvider?:'deepseek'|'tavily'|'none';
  vaultPath: string;
  vaultLastScannedAt: string | null;
  syncEnabled: boolean;
  syncDeviceName: string;
  knowledgeDocumentCount: number;
  knowledgeChunkCount: number;
}

export interface SyncStatus {
  enabled: boolean;
  deviceId: string;
  deviceName: string;
  folderPath: string;
  lastRunAt: string | null;
  lastError: string | null;
  pendingOperations: number;
  conflictCount: number;
}

export interface HomeData {
  projects: Project[];
  tasks: Task[];
  documents: DocumentRecord[];
  vaultLastScannedAt: string | null;
  projectLastChangedAt: string | null;
}
