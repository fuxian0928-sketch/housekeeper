import { listManagedSkills, loadSkillInstructionTree, recordManagedSkillUse } from './skill-manager.js';
import { skillRequirements } from './skill-requirements.js';
import { listSkillTools } from './skill-tool-registry.js';

/** Metadata only: no files, model calls or network work on ordinary chat turns. */
export function agentSkillCatalog() {
  const tools = new Set(listSkillTools().filter(tool => tool.enabled).map(tool => tool.name));
  return listManagedSkills().filter(skill => skill.enabled && skill.status === 'installed').slice(0, 80).map(skill => {
    const unavailable = skillRequirements(skill.id).filter(name => !tools.has(name));
    return { id: skill.id, name: skill.name, description: skill.description, available: !unavailable.length,
      ...(unavailable.length ? { unavailableTools: unavailable } : {}) };
  });
}

export async function loadAgentSkill(id: string) {
  const skill = listManagedSkills().find(item => item.id === id && item.enabled && item.status === 'installed');
  if (!skill) throw new Error('技能不存在、未启用或尚未安装。');
  const tools = new Set(listSkillTools().filter(tool => tool.enabled).map(tool => tool.name));
  const unavailable = skillRequirements(id).filter(name => !tools.has(name));
  if (unavailable.length) throw new Error(`技能所需工具尚不可用：${unavailable.join('、')}。请说明缺口，不得假称已执行。`);
  const instruction = await loadSkillInstructionTree(skill);
  if (!instruction.trim()) throw new Error('技能入口无法读取，请检查技能文件。');
  if (Buffer.byteLength(instruction, 'utf8') > 40_000) throw new Error('技能规则过长，请拆分后使用。');
  recordManagedSkillUse(skill, 'agent_on_demand', Buffer.byteLength(instruction, 'utf8'));
  return { id: skill.id, name: skill.name, version: skill.version, instruction };
}
