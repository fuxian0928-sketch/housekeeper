import { DatePicker } from '../../components/DatePicker';
import { StyledSelect } from './../../components/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, Check, ChevronRight, FileText, LoaderCircle, Paperclip, Plus, Search, Send, Upload, X } from 'lucide-react';
import xiaoEAvatar from '../../assets/xiao-e-avatar.png';
import type { AppSettings, ChatAnalysisStep, ChatCitation, ChatMessage, DocumentRecord, Priority, Project, Task, TaskBatchSuggestion, TaskSuggestion } from '../../types';
import { AppIconButton, FormSelect } from '../../components/ui';

const chatReasoningOptions: ReadonlyArray<{ value: AppSettings['reasoningEffort']; label: string }> = [
  { value: 'auto', label: '跟随模型默认' }, { value: 'low', label: '快速思考' }, { value: 'medium', label: '标准思考' }, { value: 'high', label: '深入思考' }
];

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

const markdownPlugins = [remarkGfm];

function submitMessageOnEnter(event: React.KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

export function MarkdownAnswer({ content }: { content: string }) {
  const leakedEndToken = /<\|(?:eos|endoftext|im_end)\|>/i.test(content);
  const displayContent = content.replace(/<\|(?:eos|endoftext|im_end)\|>/gi, '').trim();
  const answer = leakedEndToken ? `${displayContent}\n\n> 模型提前返回了结束标记，本次回答可能不完整。你可以回复“继续回答”。` : displayContent;
  return <div className="chat-answer markdown-body"><ReactMarkdown remarkPlugins={markdownPlugins} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a> }}>{answer}</ReactMarkdown></div>;
}

export function ConversationCitations({ citations }: { citations?: ChatCitation[] }) {
  if (!citations?.length) return null;
  return <details className="chat-citations">
    <summary><span><FileText size={14} aria-hidden="true" />{citations.every(citation => citation.path.startsWith('self://')) ? '查看自查询依据' : '查看相关文档'}</span><b>{citations.length}</b><ChevronRight size={14} aria-hidden="true" /></summary>
    <div className="chat-citation-list">
      {citations.map((citation) => <details className="chat-citation" key={`${citation.document}-${citation.path}-${citation.excerpt}`}><summary>{citation.document}</summary><p>{citation.excerpt}</p>{/^https?:\/\//i.test(citation.path) ? <a href={citation.path} target="_blank" rel="noreferrer">打开外部来源</a> : <span>{citation.path}</span>}</details>)}
    </div>
  </details>;
}

export function ConversationWorkspace(props: { modelSelector: React.ReactNode; routingModeSelector: React.ReactNode; projects: Project[]; projectId: string; onProjectChange: (id: string) => void; reasoningEffort: AppSettings['reasoningEffort']; onReasoningEffortChange: (value: AppSettings['reasoningEffort']) => void; maxTokens: string; onMaxTokensChange: (value: string) => void; documents: DocumentRecord[]; referencedDocumentPaths: string[]; onReferencedDocumentPathsChange: (paths: string[]) => void; onImportOffice: (file: File) => Promise<DocumentRecord>; messages: ChatMessage[]; input: string; busy: boolean; conversationLoadBusy: boolean; responseMode: 'local-retrieval' | 'local-fallback' | 'openai'; conversationId: string | null; compressedAt: string | null; compressBusy: boolean; onInput: (value: string) => void; onSend: (event: React.FormEvent) => void; onStop: () => void; onCompress: () => void; onNew: () => void; onSaveTaskSuggestion: (suggestion: TaskSuggestion, suggestionId: string | null | undefined, messageIndex: number) => void; onSaveTaskBatchSuggestion: (suggestion: TaskBatchSuggestion, suggestionId: string | null | undefined, messageIndex: number) => void }) {
  const streamRef = useRef<HTMLDivElement>(null);
  const [documentPickerOpen, setDocumentPickerOpen] = useState(false);
  const followStream = useRef(true);
  const lastScrollTop = useRef(0);
  const [showLatest, setShowLatest] = useState(false);
  const emptyConversation = props.messages.length === 0;
  useLayoutEffect(() => {
    // A server-assigned ID at the end of a new answer is not a new reading session.
    if (props.conversationLoadBusy || emptyConversation) {
      followStream.current = true;
      lastScrollTop.current = 0;
      setShowLatest(false);
    }
  }, [props.conversationLoadBusy, emptyConversation]);
  const lastMessage = props.messages.at(-1);
  const projectOptions = useMemo(() => [{ value: 'global', label: '全部资料与记忆' }, ...props.projects.map((project) => ({ value: project.id, label: project.name }))], [props.projects]);
  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    if (!lastMessage) stream.scrollTop = 0;
    else if (followStream.current) stream.scrollTop = stream.scrollHeight;
    lastScrollTop.current = stream.scrollTop;
  }, [lastMessage?.content, lastMessage?.analysisSteps?.length, props.busy, props.conversationLoadBusy]);
  return <div className="conversation-page">
    <header className="conversation-page-header">
      <div><h1>{props.conversationId ? '继续和小E聊聊' : '和小E聊聊'}</h1><p>{props.projectId === 'global' ? '聊工作、聊想法，也聊聊你的今天' : `只使用 ${props.projects.find((project) => project.id === props.projectId)?.name ?? '当前项目'} 的资料`}{props.compressedAt ? ' · 已使用压缩上下文' : ''}</p></div>
      <button className="secondary-button" type="button" onClick={props.onNew}><Plus size={16} />新建对话</button>
    </header>
    <section className="conversation-canvas">
      <div className="conversation-stream" ref={streamRef} onWheel={event => { if (event.deltaY < 0) { followStream.current = false; setShowLatest(true); } }} onScroll={() => {
        const stream = streamRef.current;
        if (!stream) return;
        const movingUp = stream.scrollTop < lastScrollTop.current;
        followStream.current = !movingUp && stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 8;
        lastScrollTop.current = stream.scrollTop;
        setShowLatest(!followStream.current);
      }} aria-live="polite" aria-busy={props.conversationLoadBusy}>
        {props.conversationLoadBusy ? <div className="conversation-content-loading" role="status"><LoaderCircle className="spin" size={22} /><strong>正在打开对话…</strong><span>正在从服务器读取历史消息</span></div> : props.messages.length === 0 ? <div className="conversation-welcome"><div className="welcome-orbit"><span className="welcome-orbit-track" aria-hidden="true" /><img src={xiaoEAvatar} width="64" height="64" alt="小E" /></div><h2>今天，想从哪里聊起？</h2><p>一起理清下一步，或给今天的心情留一点空间。</p><div className="conversation-starters">{['帮我梳理项目的下一步', '帮我查找知识库中的资料', '今天有点累，陪我聊聊'].map(text => <button type="button" key={text} onClick={() => props.onInput(text)}>{text}<ChevronRight size={14} /></button>)}</div></div> : null}
        {!props.conversationLoadBusy ? props.messages.map((message, index) => <div className={`conversation-message ${message.role}`} key={message.createdAt ?? `${message.role}-${index}`}>
          {message.role === 'assistant' ? <img className="assistant-avatar" src={xiaoEAvatar} width="38" height="38" alt="" aria-hidden="true" /> : null}
          <div className="message-content">
            {message.role === 'assistant' ? <span className="sr-only">小E：</span> : null}
            {props.busy && index === props.messages.length - 1 && message.analysisSteps?.length ? <ChatAnalysis steps={message.analysisSteps} streaming /> : null}
            {message.content ? message.role === 'assistant' ? <MarkdownAnswer content={message.content} /> : <div className="chat-answer plain-text">{message.content}</div> : null}
            {message.taskSuggestion ? <TaskSuggestionCard suggestion={message.taskSuggestion} saved={Boolean(message.suggestionSaved)} onSave={(suggestion) => props.onSaveTaskSuggestion(suggestion, message.suggestionId, index)} /> : null}
            {message.taskBatchSuggestion ? <TaskBatchSuggestionCard suggestion={message.taskBatchSuggestion} saved={Boolean(message.suggestionSaved)} onSave={(suggestion) => props.onSaveTaskBatchSuggestion(suggestion, message.suggestionId, index)} /> : null}
            <ConversationCitations citations={message.citations} />
          </div>
        </div>) : null}
      </div>
      {showLatest && <button className="latest-message-button secondary-button" type="button" onClick={() => { followStream.current = true; setShowLatest(false); if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight; }}>回到最新消息</button>}
      <form className="conversation-composer" onSubmit={props.onSend}>
        <div className="composer-toolbar" aria-label="对话设置">
          {props.modelSelector}{props.routingModeSelector}
          <div className="conversation-control project-control"><span>项目</span><FormSelect label="项目范围" value={props.projectId} options={projectOptions} disabled={props.conversationLoadBusy} onChange={props.onProjectChange} /></div>
          <div className="conversation-control"><span>思考</span><FormSelect label="思考程度" value={props.reasoningEffort} options={chatReasoningOptions} onChange={props.onReasoningEffortChange} /></div>
          <button className="document-picker-button" type="button" onClick={() => setDocumentPickerOpen(true)}><Paperclip size={15} /><span>引用文档</span>{props.referencedDocumentPaths.length ? <b>{props.referencedDocumentPaths.length}</b> : null}</button>
        </div>
        <textarea aria-label="给小E的消息" name="message" autoComplete="off" value={props.input} disabled={props.busy || props.conversationLoadBusy} onChange={(event) => props.onInput(event.target.value)} onKeyDown={submitMessageOnEnter} placeholder={props.conversationLoadBusy ? '正在打开对话…' : props.busy ? 'AI 秘书正在回答…' : '说说你的想法，工作或生活都可以…'} />
        {props.referencedDocumentPaths.length ? <div className="composer-reference-count"><Paperclip size={13} />已引用 {props.referencedDocumentPaths.length} 篇</div> : null}
        {props.busy ? <button className="send-button stop" type="button" onClick={props.onStop} aria-label="停止回答"><X size={17} /></button> : <button className="send-button" type="submit" disabled={props.conversationLoadBusy || !props.input.trim()} aria-label="发送"><Send size={17} /></button>}
      </form>
      <p className="conversation-footnote">{props.responseMode === 'openai' ? '服务器检索 + 大模型回答' : props.responseMode === 'local-fallback' ? '模型暂不可用，已切回规则回答' : '服务器检索模式'} · 默认只读，写入前必须二次确认</p>
    </section>
    {documentPickerOpen ? <DocumentPickerDialog documents={props.documents} selectedPaths={props.referencedDocumentPaths} onImportOffice={props.onImportOffice} onConfirm={(paths) => { props.onReferencedDocumentPathsChange(paths); setDocumentPickerOpen(false); }} onClose={() => setDocumentPickerOpen(false)} /> : null}
  </div>;
}

function DocumentPickerDialog({ documents, selectedPaths, onImportOffice, onConfirm, onClose }: { documents: DocumentRecord[]; selectedPaths: string[]; onImportOffice: (file: File) => Promise<DocumentRecord>; onConfirm: (paths: string[]) => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [draftPaths, setDraftPaths] = useState<string[]>(() => [...selectedPaths]);
  const [importBusy, setImportBusy] = useState(false);
  const filteredDocuments = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('zh-CN');
    if (!keyword) return documents;
    return documents.filter((document) => `${document.title} ${document.relativePath}`.toLocaleLowerCase('zh-CN').includes(keyword));
  }, [documents, query]);
  useEffect(() => {
    dialogRef.current?.showModal();
    return () => { if (dialogRef.current?.open) dialogRef.current.close(); };
  }, []);
  const selectedSet = useMemo(() => new Set(draftPaths), [draftPaths]);
  const toggle = (path: string) => setDraftPaths((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  const selectFiltered = () => setDraftPaths((current) => [...new Set([...current, ...filteredDocuments.map((document) => document.relativePath)])]);
  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setImportBusy(true);
    try { const document = await onImportOffice(file); setDraftPaths((current) => [...new Set([...current, document.relativePath])]); }
    catch { /* App 已显示具体错误。 */ }
    finally { setImportBusy(false); }
  };
  return <dialog ref={dialogRef} className="document-picker-dialog" aria-labelledby="document-picker-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="document-picker-dialog-shell">
      <header><div><h2 id="document-picker-title">选择引用文档</h2><p>勾选后确认，本轮及后续对话都会携带这些文档。</p></div><div className="document-picker-header-actions"><input ref={fileInputRef} className="visually-hidden" type="file" accept=".docx,.xlsx,.pptx" onChange={importFile} /><button className="secondary-button" type="button" disabled={importBusy} onClick={() => fileInputRef.current?.click()}>{importBusy ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}{importBusy ? '解析中…' : '导入 Office'}</button><AppIconButton label="关闭文档选择" onClick={onClose}><X size={18} /></AppIconButton></div></header>
      <div className="document-picker-search"><Search size={16} aria-hidden="true" /><input name="documentSearch" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文档名称或路径…" aria-label="搜索文档" /><span>{filteredDocuments.length} 篇</span></div>
      <div className="document-picker-toolbar"><span>已选 {draftPaths.length} 篇</span><div><button type="button" disabled={!filteredDocuments.length} onClick={selectFiltered}>全选当前列表</button><button type="button" disabled={!draftPaths.length} onClick={() => setDraftPaths([])}>清空</button></div></div>
      <div className="document-picker-dialog-list">
        {filteredDocuments.map((document) => <label className={selectedSet.has(document.relativePath) ? 'selected' : ''} key={document.id}><input type="checkbox" checked={selectedSet.has(document.relativePath)} onChange={() => toggle(document.relativePath)} /><FileText size={17} aria-hidden="true" /><span><strong>{document.title}</strong><small>{document.relativePath}</small></span><time>{formatDateTime(document.modifiedAt)}</time></label>)}
        {filteredDocuments.length === 0 ? <div className="document-picker-dialog-empty"><FileText size={22} /><strong>{documents.length ? '没有匹配的文档' : '当前范围还没有文档'}</strong><p>{documents.length ? '换一个关键词试试。' : '先在资料库中读取 Obsidian 文档。'}</p></div> : null}
      </div>
      <footer><span>{draftPaths.length ? `将引用 ${draftPaths.length} 篇文档` : '不引用指定文档'}</span><div><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => onConfirm(draftPaths)}>确认引用</button></div></footer>
    </div>
  </dialog>;
}

export function ChatAnalysis({ steps, streaming }: { steps: ChatAnalysisStep[]; streaming: boolean }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (streaming) setOpen(true);
    else if (steps.length) setOpen(false);
  }, [streaming, steps.length]);
  return <details className="chat-analysis" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span>{streaming ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}</span>{streaming ? '正在分析' : '查看分析过程'}<ChevronRight size={14} /></summary>
    <div className="chat-analysis-steps">{steps.map((step) => <div className={`chat-analysis-step ${step.status}`} key={step.id}><span>{step.status === 'active' ? <LoaderCircle className="spin" size={13} /> : step.status === 'warning' ? <AlertTriangle size={13} /> : <Check size={13} />}</span><div><strong>{step.label}</strong>{step.detail ? <p>{step.detail}</p> : null}</div></div>)}</div>
  </details>;
}

export function TaskSuggestionCard({ suggestion, saved, onSave }: { suggestion: TaskSuggestion; saved: boolean; onSave: (suggestion: TaskSuggestion) => void }) {
  const [title, setTitle] = useState(suggestion.title);
  const [priority, setPriority] = useState<Priority>(suggestion.priority);
  const [executor, setExecutor] = useState<Task['executor']>(suggestion.executor);
  const [dueAt, setDueAt] = useState(suggestion.dueAt?.slice(0, 10) ?? '');
  return <div className="task-suggestion">
    <strong>待确认任务</strong>
    <label><span>任务名称</span><input required maxLength={120} disabled={saved} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <div className="task-suggestion-fields">
      <label><span>优先级</span><StyledSelect disabled={saved} value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></StyledSelect></label>
      <label><span>执行方</span><StyledSelect disabled={saved} value={executor} onChange={(event) => setExecutor(event.target.value as Task['executor'])}><option value="self">我自己</option><option value="ai">AI 秘书</option><option value="external">外部人员</option></StyledSelect></label>
      <label><span>截止日期</span><DatePicker label="截止日期" disabled={saved} value={dueAt} onChange={setDueAt} /></label>
    </div>
    <button className="secondary-button" type="button" disabled={saved || !title.trim()} onClick={() => onSave({ ...suggestion, title: title.trim(), priority, executor, dueAt: dueAt || null })}>{saved ? <><Check size={15} />已加入项目</> : '确认并加入任务'}</button>
  </div>;
}

export function TaskBatchSuggestionCard({ suggestion, saved, onSave }: { suggestion: TaskBatchSuggestion; saved: boolean; onSave: (suggestion: TaskBatchSuggestion) => void }) {
  const [drafts, setDrafts] = useState(() => suggestion.tasks.map((task) => ({ ...task, selected: true })));
  const selectedCount = drafts.filter((task) => task.selected && task.title.trim()).length;
  return <div className="task-suggestion task-batch-suggestion"><strong>可批量转成任务</strong><p>已从回答中整理出 {drafts.length} 项，你可以取消或修改后一次确认。</p>
    <div className="task-batch-list">{drafts.map((task, index) => <label key={`${index}-${task.sourceLabel}`}><input type="checkbox" disabled={saved} checked={task.selected} onChange={(event) => setDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, selected: event.target.checked } : item))} /><input disabled={saved || !task.selected} maxLength={120} value={task.title} onChange={(event) => setDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item))} /></label>)}</div>
    <button className="secondary-button" type="button" disabled={saved || selectedCount === 0} onClick={() => onSave({ ...suggestion, tasks: drafts.filter((task) => task.selected && task.title.trim()).map(({ selected: _selected, ...task }) => ({ ...task, title: task.title.trim() })) })}>{saved ? <><Check size={15} />任务已批量创建</> : `确认创建 ${selectedCount} 个任务`}</button>
  </div>;
}
