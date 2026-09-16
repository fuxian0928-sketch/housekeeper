import { SourceSnapshot } from './source-snapshot.js';
import { readDiagnostics } from './diagnostics.js';
import { listSkillTools } from '../skills/skill-tool-registry.js';
import { listManagedSkills } from '../skills/skill-manager.js';
import { officeCapabilityStatus } from '../documents/office-document-parser.js';
import { database, sqliteVecAvailable } from '../../db.js';
import { currentSchemaVersion } from '../../storage/migrations.js';

export type SelfRuntime = { model: string; defaultModel: string; aiEnabled: boolean; hasApiKey: boolean; hasRetrievalApiKey: boolean; hasWebSearchApiKey: boolean; webSearchPolicy: string; mode: string; clientVersion: string | null; conversationId: string; requestId: string };
export const selfTools = [
  { name: 'get_self_capabilities', description: '当前服务实际注册工具和可用条件，不能把源码存在等同于界面已开放', parameters: '{}' },
  { name: 'get_runtime_status', description: '本轮实际选择模型、服务配置状态、版本快照、数据库可读性；未主动探测外部服务', parameters: '{}' },
  { name: 'get_execution_result', description: '当前对话的任务执行与记忆观察、最近脱敏诊断，不含用户原文和原始错误', parameters: '{}' },
  { name: 'search_own_code', description: '检索当前服务构建附带的源码快照，可用函数名、模块名和空格分隔的检索词', parameters: '{query:string}' },
  { name: 'read_own_code', description: '按快照返回的精确文件路径和行号读取源码，不能访问磁盘任意路径', parameters: '{path:string,startLine?:number,count?:number}' }
] as const;
export class SelfService {
  constructor(readonly source = new SourceSnapshot()) {}
  runtime(context: SelfRuntime) {
    let databaseReadable = false;
    try { databaseReadable = Boolean(database.prepare('SELECT 1 AS ok').get()); } catch { /* report observation */ }
    return { observedAt: new Date().toISOString(), requestId: context.requestId, currentTurnModel: context.model, configuredDefaultModel: context.defaultModel,
      client: { version: context.clientVersion, source: 'client-reported-not-attested' }, server: { mode: context.mode, source: this.source.info(), databaseReadable, schemaVersion: currentSchemaVersion(database), vectorExtensionLoaded: sqliteVecAvailable },
      model: { enabled: context.aiEnabled, credentialConfigured: context.hasApiKey, reachability: 'not_probed' }, retrieval: { credentialConfigured: context.hasRetrievalApiKey, reachability: 'not_probed' }, webSearch: { policy: context.webSearchPolicy, credentialConfigured: context.hasWebSearchApiKey, reachability: 'not_probed' },
      note: '已配置不等于连接成功；本轮选择模型不等于供应商已经成功响应。版本缺失时明确未知，不用代码版本代替客户端版本。' };
  }
  execute(name: string, args: Record<string, unknown>, context: SelfRuntime): unknown {
    if (!selfTools.some(tool => tool.name === name)) throw new Error('未知的只读自查询工具');
    const short = (key: string) => { const value = args[key]; if (typeof value !== 'string' || !value.trim() || value.length > 300) throw new Error('工具参数无效'); return value.trim(); };
    switch(name) {
      case 'get_runtime_status': return this.runtime(context);
      case 'get_self_capabilities': return { observedAt: new Date().toISOString(), source: 'registered-server-tools', selfTools, tools: listSkillTools(), documentProcessing: officeCapabilityStatus(),
        skills: listManagedSkills().map(skill => ({ name: skill.name, version: skill.version, status: skill.status, enabled: skill.enabled })),
        availability: { modelConfigured: context.aiEnabled && context.hasApiKey, skillTools: '注册的工具需经技能权限与确认流程调用；不代表所有工具已在聊天或UI中开放', sourceCode: this.source.status },
        restrictions: ['本组工具只读，不执行代码、不重启、不部署、不修改记忆', '源码中的历史组件不能证明界面当前有入口'] };
      case 'get_execution_result': return readDiagnostics(context.conversationId);
      case 'search_own_code': return this.source.search(short('query'));
      case 'read_own_code': {
        const start = args.startLine ?? 1, count = args.count ?? 70;
        if (typeof start !== 'number' || !Number.isInteger(start) || start < 1 || typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100) throw new Error('行号参数无效');
        return this.source.read(short('path'), start, count);
      }
    }
  }
}
