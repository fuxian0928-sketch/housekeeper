import { DatePicker } from '../../components/DatePicker';
import { StyledSelect } from './../../components/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, MessageSquare, Send, Settings, Square } from 'lucide-react';
import { RunInspector } from '../agent/RunInspector';
import { MessageExecution } from './MessageExecution';
import { ProcessRows } from '../agent/ProcessRows';
import { useAgentRun } from '../agent/useAgentRun';
import { VoiceStage } from '../agent/VoiceStage';
import { ResizableWorkbench } from './ResizableWorkbench';
import { ConversationRecords } from './ConversationRecords';
import { UserMessageBubble } from './UserMessageBubble';
import {WorkbenchTabs, type WorkbenchTabsModel} from './WorkbenchTabs';
import type {DocumentEvidence, WorkbenchTab} from './workbench-tabs';
import xiaoEAvatar from '../../assets/xiao-e-avatar.png';
import type { ChatAnalysisStep, ChatMessage, Priority, Task, TaskBatchSuggestion, TaskSuggestion } from '../../types';
import {ConversationCitations} from './ConversationCitations';
export {ConversationCitations} from './ConversationCitations';

function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
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

export type WorkbenchPanel = 'resource' | 'transcript' | 'results' | null;
export function ConversationWorkspace(props: {
  modelSelector: React.ReactNode;
  workbench: WorkbenchTabsModel; onPanelChange: (panel: WorkbenchPanel) => void; renderResourceTab: (tab: WorkbenchTab) => React.ReactNode;
  onOpenSettings: () => void; onOpenCapabilities: () => void; onOpenMemoryStarfield: () => void;
  messages: ChatMessage[]; input: string; busy: boolean; conversationLoadBusy: boolean; conversationId: string | null;
  onInput: (value: string) => void; onSend: (event: React.FormEvent) => void; onStop: () => void; onNew: () => void;
  onSaveTaskSuggestion: (suggestion: TaskSuggestion, suggestionId: string | null | undefined, messageIndex: number) => void; onSaveTaskBatchSuggestion: (suggestion: TaskBatchSuggestion, suggestionId: string | null | undefined, messageIndex: number) => void;
  onContinueRun:(id:string,message?:string)=>Promise<void>;onOpenDocument:(id:string,version?:number,evidence?:DocumentEvidence)=>void;onBusinessChanged:()=>Promise<void>;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputAreaRef = useRef<HTMLFormElement>(null);
  const activeRunId=props.messages.reduce<string|null>((id,message)=>message.runId??id,null);
  const runState=useAgentRun(activeRunId,props.busy);
  const composerOnRight=props.workbench.active?.kind==='transcript';
  const previousActivity = useRef({count:props.messages.length,busy:props.busy,status:props.messages.at(-1)?.runStatus});
  const previousResult = useRef('');
  const lastMessage = props.messages.at(-1);
  useLayoutEffect(() => {
    const textarea=inputRef.current;if(!textarea)return;
    const resize=()=>{textarea.style.height='0px';const style=getComputedStyle(textarea),lineHeight=parseFloat(style.lineHeight)||21,padding=parseFloat(style.paddingTop)+parseFloat(style.paddingBottom);textarea.style.height=`${Math.min(textarea.scrollHeight,lineHeight*10+padding)}px`;textarea.style.overflowY=textarea.scrollHeight>lineHeight*10+padding?'auto':'hidden';};
    resize();let previousWidth=textarea.clientWidth;const observer=new ResizeObserver(()=>{if(textarea.clientWidth===previousWidth)return;previousWidth=textarea.clientWidth;resize();});if(inputAreaRef.current)observer.observe(inputAreaRef.current);
    return()=>observer.disconnect();
  },[props.input,composerOnRight]);
  useEffect(()=>{
    const previous=previousActivity.current;
    previousActivity.current={count:props.messages.length,busy:props.busy,status:lastMessage?.runStatus};
    if(props.conversationLoadBusy)return;
    const newActivity=props.messages.length>previous.count||(props.busy&&!previous.busy);
    if(newActivity&&props.workbench.activeId===null)props.onPanelChange('transcript');
  },[props.messages.length,props.busy,props.conversationLoadBusy,lastMessage?.runStatus,props.workbench.activeId,props.onPanelChange]);
  useEffect(()=>{
    const view=runState.view;if(!view)return;
    const available=view.artifacts.length>0||['waiting_approval','reconciling'].includes(view.run.status);
    const signature=`${view.run.id}:${view.artifacts.length}:${view.run.status}`;
    if(!available||signature===previousResult.current)return;
    previousResult.current=signature;
    if(['waiting_approval','reconciling'].includes(view.run.status))props.onPanelChange('transcript');
    else props.workbench.open({id:'results',kind:'results',title:'成果与进展',attention:true},true);
  },[runState.view?.run.id,runState.view?.run.status,runState.view?.artifacts.length,props.workbench.open,props.onPanelChange]);
  const renderMessage=(message:ChatMessage,index:number|null)=><div className={`conversation-message ${message.role}`} key={message.clientKey??message.id??`${message.role}-${message.createdAt??index}-${index}`}>
    {message.role==='assistant'?<img className="assistant-avatar" src={xiaoEAvatar} width="28" height="28" alt="" aria-hidden="true"/>:null}
    <div className="message-content">
      <span className="sr-only">{message.role==='assistant'?'希微：':'你：'}</span>
      {message.role==='assistant'&&message.runId?<MessageExecution runId={message.runId} state={message.runId===activeRunId?runState:undefined} disabled={props.conversationLoadBusy} onContinue={props.onContinueRun} onOpenDocument={props.onOpenDocument} onBusinessChanged={props.onBusinessChanged}/>:message.role==='assistant'&&message.analysisSteps?.length?<ChatAnalysis steps={message.analysisSteps} streaming={props.busy&&index===props.messages.length-1}/>:null}
      {message.content?message.role==='assistant'?<MarkdownAnswer content={message.content}/>:<UserMessageBubble content={message.content}/>:null}
      {index!==null&&message.taskSuggestion?<TaskSuggestionCard suggestion={message.taskSuggestion} saved={Boolean(message.suggestionSaved)} onSave={suggestion=>props.onSaveTaskSuggestion(suggestion,message.suggestionId,index)}/>:null}
      {index!==null&&message.taskBatchSuggestion?<TaskBatchSuggestionCard suggestion={message.taskBatchSuggestion} saved={Boolean(message.suggestionSaved)} onSave={suggestion=>props.onSaveTaskBatchSuggestion(suggestion,message.suggestionId,index)}/>:null}
      <ConversationCitations citations={message.citations} onOpenDocument={props.onOpenDocument}/>
      {message.createdAt&&!Number.isNaN(Date.parse(message.createdAt))?<time className="message-timestamp" dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString('zh-CN')}>{formatMessageTime(message.createdAt)}</time>:null}
    </div>
  </div>;
  const composer=<form ref={inputAreaRef} className="conversation-composer" onSubmit={props.onSend}>
    <textarea ref={inputRef} rows={1} wrap="soft" aria-label="给希微的消息" name="message" autoComplete="off" value={props.input} disabled={props.busy||props.conversationLoadBusy} onChange={event=>props.onInput(event.target.value)} onKeyDown={submitMessageOnEnter} placeholder={props.conversationLoadBusy?'正在打开对话…':props.busy?'希微正在回应…':'也可以在这里输入…'}/>
    <div className="composer-toolbar" aria-label="对话设置">{props.modelSelector}</div>
    {props.busy?<button className="send-button stop" type="button" onClick={props.onStop} aria-label="停止回答"><Square size={14} fill="currentColor"/></button>:<button className="send-button" type="submit" disabled={props.conversationLoadBusy||!props.input.trim()} aria-label="发送"><Send size={16}/></button>}
  </form>;
  const pane=<WorkbenchTabs model={props.workbench} render={(tab,active)=>tab.kind==='transcript'
    ?<div className="workbench-transcript" data-workbench-panel aria-label="聊天记录"><ConversationRecords active={active} conversationId={props.conversationId} messages={props.messages} busy={props.busy} loading={props.conversationLoadBusy} renderMessage={renderMessage}/>{composerOnRight?composer:null}</div>
    :tab.kind==='results'?<div className="workbench-results" data-workbench-panel><RunInspector key={activeRunId??'empty'} runId={activeRunId} runState={runState} disabled={props.conversationLoadBusy} onContinue={props.onContinueRun} onOpenDocument={props.onOpenDocument} onBusinessChanged={props.onBusinessChanged}/></div>
    :<div className="workbench-resource" data-workbench-panel>{props.renderResourceTab(tab)}</div>}/>;
  return <div className="conversation-page voice-first-workspace command-workbench">
    <header className="conversation-page-header">
      <div className="workbench-identity"><h1>希微</h1><p>事务、知识与日常</p></div>
      <div className="workbench-header-actions">
        <div className="workbench-action-group" role="group" aria-label="查看内容">
          <button className="icon-button" type="button" data-tooltip="聊天记录" aria-label="聊天记录" aria-pressed={props.workbench.active?.kind==='transcript'} onClick={()=>props.onPanelChange('transcript')}><MessageSquare size={16}/></button>
        </div>
        <div className="workbench-action-group" role="group" aria-label="管理希微">
          <button className="icon-button" type="button" data-tooltip="设置" aria-label="设置" onClick={props.onOpenSettings}><Settings size={16}/></button>
        </div>
      </div>
    </header>
    <ResizableWorkbench open={props.workbench.activeId!==null} pane={pane} keepAlive goldenDefault>
    <section className="conversation-canvas">
      <VoiceStage/>
      {!composerOnRight?composer:null}
      <p className="conversation-footnote">Enter 发送 · Shift + Enter 换行 · 修改按你的工具确认设置执行</p>
    </section>
    </ResizableWorkbench>
  </div>;
}

export function ChatAnalysis({ steps, streaming }: { steps: ChatAnalysisStep[]; streaming: boolean }) {
  return <ProcessRows label={streaming?'正在处理':'执行过程'} rows={steps.map(step=>({id:step.id,label:step.label,status:step.status==='active'?streaming?'running':'paused':step.status==='warning'?'unknown':'recorded',details:step.detail?[{label:step.detail}]:[]}))}/>;
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
