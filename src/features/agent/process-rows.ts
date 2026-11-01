import type {RunEvent,RunInvocation,RunStatus,RunView} from './types';

export type ProcessStatus='pending'|'running'|'done'|'failed'|'waiting'|'paused'|'unknown'|'cancelled'|'recorded';
export type ProcessDetail={label:string;meta?:string;createdAt?:string};
export type ProcessRow={id:string;label:string;status:ProcessStatus;meta?:string;details:ProcessDetail[]};

const toolLabels:Record<string,string>={
  search_web:'联网检索',fetch_web:'读取网页原文',
  list_projects:'查找项目',get_project:'读取项目进展',list_project_tasks:'核对项目待办',list_project_documents:'查找项目资料',
  search_documents:'检索知识与历史文档',get_document:'读取文档原文',list_document_versions:'查看文档历史',get_document_version:'核对历史版本',
  create_project:'创建项目',update_project:'更新项目信息',create_task:'创建待办',update_task:'更新待办',
  create_document:'保存文档',update_document:'更新文档',patch_document:'修改文档片段',
  link_document_to_project:'关联项目资料',link_document_to_task:'关联任务资料',
  read_spreadsheet:'读取表格数据',summarize_spreadsheet:'计算表格汇总',export_spreadsheet:'生成 Excel 文件',patch_office_file:'修改 Office 文件',
  search_conversation_history:'查找聊天档案',read_work_record:'核对历史事务',
  computer_tools:'读取电脑控制能力',computer_snapshot:'查看当前窗口',computer_action:'操作电脑',
  find_capabilities:'查找可用能力',load_capability:'读取工具参数',load_skill:'读取技能规则',
  resolve_reference:'定位相关对象',show_resource:'调出相关页面',show_draft:'准备文档草稿',ask_user:'整理待补充信息'
};
const toolEventStatus:Record<string,ProcessStatus>={tool_started:'running',tool_succeeded:'done',tool_failed:'failed',approval_required:'waiting',tool_unknown:'unknown',late_receipt:'unknown',computer_control_wait:'waiting',computer_control_ready:'running'};
const invocationStatus:Record<string,ProcessStatus>={prepared:'pending',waiting_approval:'waiting',dispatching:'running',succeeded:'done',failed:'failed',unknown:'unknown',cancelled:'cancelled'};
const terminalStatuses=new Set<RunStatus>(['completed','partial','failed','cancelled','suspended','waiting_input','waiting_approval','reconciling']);

function detailData(event:RunEvent):Record<string,unknown>{return event.detail&&typeof event.detail==='object'?event.detail as Record<string,unknown>:{};}
function interruptStatus(status:RunStatus):ProcessStatus{
  if(status==='failed')return 'failed';
  if(status==='cancelled')return 'cancelled';
  if(status==='reconciling'||status==='completed'||status==='partial')return 'unknown';
  return 'paused';
}
function toolLabel(call:RunInvocation|undefined,event:RunEvent|undefined):string{
  return call&&toolLabels[call.toolName]||event?.label.replace(/^正在/,'').replace(/前需要确认$|的结果需要核实$|未完成$|完成$/,'')||call?.toolName||'调用工具';
}

// Only public operation labels and receipts are projected into the UI. Never use
// model reasoning, arguments, credentials, or tool-result bodies as row details.
export function buildProcessRows(view:RunView):ProcessRow[]{
  const events=[...view.events].sort((a,b)=>a.seq-b.seq),rows:Array<ProcessRow&{order:number}>=[];
  const calls=new Map(view.invocations.map(call=>[call.id,call]));
  const tools=new Map<string,ProcessRow&{order:number}>();
  const controlWaits=new Set<string>();
  let model:ProcessRow|undefined,lastToolEvent=false;
  for(const event of events){
    const data=detailData(event),detail:ProcessDetail={label:event.label,createdAt:event.createdAt};
    if(event.type==='model_started'){
      const next:ProcessRow&{order:number}={id:`model:${event.seq}`,label:'整理下一步',status:'running',details:[detail],order:event.seq};
      rows.push(next);model=next;lastToolEvent=false;
    }else if(event.type==='model_finished'){
      if(!model){const recovered:ProcessRow&{order:number}={id:`model:${event.seq}`,label:'整理下一步',status:'done',details:[],order:event.seq};rows.push(recovered);model=recovered;}
      model.label=data.calls===0?'整理回答':'确定处理步骤';model.status='done';model.details.push(detail);model=undefined;lastToolEvent=false;
    }else if(toolEventStatus[event.type]&&typeof data.invocationId==='string'){
      const id=data.invocationId,call=calls.get(id);
      if(event.type==='computer_control_wait')controlWaits.add(id);else controlWaits.delete(id);
      let row=tools.get(id);
      if(!row){row={id:`tool:${id}`,label:toolLabel(call,event),status:'pending',details:[],order:event.seq};rows.push(row);tools.set(id,row);}
      row.status=toolEventStatus[event.type];row.details.push(detail);lastToolEvent=true;
    }else if(event.type==='step_result'){
      // External tools already have a receipt row. Internal helpers only emit
      // "recorded", which alone does not prove the operation succeeded.
      if(!lastToolEvent)rows.push({id:`step:${event.seq}`,label:typeof data.tool==='string'?toolLabels[data.tool]??event.label:event.label,status:'recorded',details:[detail],order:event.seq});
      lastToolEvent=false;
    }
  }
  for(const [index,call] of view.invocations.entries()){
    let row=tools.get(call.id);
    if(!row){row={id:`tool:${call.id}`,label:toolLabel(call,undefined),status:'pending',details:[],order:(events.at(-1)?.seq??0)+index+1};rows.push(row);tools.set(call.id,row);}
    // The persisted invocation ledger is authoritative, including reconciliation.
    const waitingForControl=call.status==='dispatching'&&controlWaits.has(call.id);
    row.status=waitingForControl?(terminalStatuses.has(view.run.status)?interruptStatus(view.run.status):'waiting'):invocationStatus[call.status]??'unknown';
    if(call.status==='dispatching'&&terminalStatuses.has(view.run.status)&&call.mode==='write')row.status='unknown';
    row.meta=call.mode==='write'?'写入操作':'只读操作';
    if(call.error&&!row.details.some(detail=>detail.label===call.error))row.details.push({label:call.error});
    if(call.status==='waiting_approval')row.details.push({label:'尚未执行，确认后继续。'});
    if(row.status==='unknown')row.details.push({label:'先核对实际结果，避免重复执行。'});
  }
  if(terminalStatuses.has(view.run.status))for(const row of rows){
    if(row.status==='running'||row.status==='pending'){
      row.status=interruptStatus(view.run.status);
      row.details.push({label:view.run.status==='failed'?'本轮处理已停止，请查看错误后继续。':'本轮已停止推进，该步骤没有完成回执。'});
    }
  }
  if(view.run.status==='failed'&&!rows.some(row=>row.status==='failed'))rows.push({id:'run:failed',label:'本次处理未完成',status:'failed',details:[{label:view.run.error||'进度已保留，可以检查后继续处理。'}],order:Infinity});
  if(!rows.length)rows.push({id:'run:state',label:view.run.status==='queued'?'等待开始处理':view.run.status==='completed'?'本次处理已结束':'读取执行状态',status:view.run.status==='queued'?'pending':view.run.status==='completed'?'recorded':view.run.status==='running'?'running':interruptStatus(view.run.status),details:[],order:0});
  return rows.sort((a,b)=>a.order-b.order).map(({order:_order,...row})=>row);
}
