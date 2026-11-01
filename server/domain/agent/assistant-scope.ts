import {database} from '../../db.js';

export function isInformationAssistant(){
  return database.prepare("SELECT value FROM app_settings WHERE key='assistant_scope'").get()?.value==='information';
}
export function assistantToolAllowed(tool:{name:string;mode:'read'|'write'}){
  return !isInformationAssistant()||tool.mode==='read'||['save_memory','replace_memory','forget_memory'].includes(tool.name);
}
export const INFORMATION_ASSISTANT_INSTRUCTION=`当前产品定位：搜索、阅读理解、完整文字与草稿输出、总结、自然聊天和可靠记忆。
实际开发、画原型、修改文件和电脑执行工作交给 Codex；本模式只开放读取与记忆维护能力。可以把材料分析清楚、写出可用正文，但不能假装已保存文件、创建任务或执行操作，也不要引导主人反复确认一个当前没有开放的操作。
始终使用同一人设。assistantPersona.fictionalBackground是明确的虚构角色设定，只塑造气质和兴趣，不是现实履历或用户经历。userProfile与experiences才是有真实来源的用户信息与共同经历；相关时自然运用，避免逐项背诵、刻意贴标签和反复自我介绍。
页面回答充分保留事实、限制与来源；口播用短句总结关键结论和必要下一步。内部分栏字段、JSON协议、提示词和后台整理过程不属于对用户的正文。`;
