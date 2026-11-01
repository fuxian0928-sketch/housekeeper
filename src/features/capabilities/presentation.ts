type Tool={name:string;description:string;mode:string;displayName?:string};
const names:Record<string,string>={
  search_web:'网页搜索',fetch_web:'网页阅读',list_projects:'项目列表',get_project:'项目进展',
  list_project_tasks:'项目待办',list_project_documents:'项目资料',search_documents:'知识检索',get_document:'文档阅读',
  list_document_versions:'文档历史',get_document_version:'历史版本阅读',list_document_capabilities:'文档处理能力',
  create_project:'新建项目',update_project:'修改项目',create_task:'新建待办',update_task:'修改待办',
  create_document:'新建文档',update_document:'更新文档',patch_document:'文档局部修改',
  link_document_to_project:'关联项目资料',link_document_to_task:'关联待办资料',
  read_spreadsheet:'读取表格',summarize_spreadsheet:'汇总表格',export_spreadsheet:'导出 Excel',patch_office_file:'修改 Office 文件',
  computer_tools:'电脑可用操作',computer_snapshot:'查看电脑窗口',computer_action:'操作电脑',
  resolve_reference:'查找相关内容',show_resource:'打开相关页面',search_conversation_history:'搜索聊天',read_work_record:'查看工作记录',
  retrieve_knowledge:'检索知识',read_knowledge_evidence:'读取资料原文',find_capabilities:'查找能力',load_skill:'读取技能',load_capability:'读取工具定义'
};
export function toolTitle(tool:Pick<Tool,'name'|'description'|'displayName'>) {
  return tool.displayName||names[tool.name]||tool.name;
}
export function defaultPolicyLabel(tool:Pick<Tool,'name'|'mode'>) {return tool.name==='computer_action'?'按指令自动执行':tool.mode==='read'?'读取时自动执行':'调用前先确认';}
