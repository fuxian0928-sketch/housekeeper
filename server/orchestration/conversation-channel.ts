import { parseTurnRoutingMode } from './turn-routing.js';

/** History grouping is not a business/project permission context. */
export function conversationChannel(input: { interactionMode?: unknown; routingMode?: unknown; projectId?: unknown; scope?: unknown; projectRouting?:unknown; agentRuntime?:unknown }, voiceArchiveId: string) {
  const channel = input.interactionMode ?? 'text';
  if (channel !== 'text' && channel !== 'voice') throw Object.assign(new Error('对话方式无效。'), { statusCode: 400 });
  const routingMode = parseTurnRoutingMode(input.routingMode === undefined && channel === 'voice' ? 'life' : input.routingMode);
  if (input.projectId != null && typeof input.projectId !== 'string') throw Object.assign(new Error('项目标识无效。'), { statusCode: 400 });
  let projectId = (input.projectId as string | null | undefined) ?? null;
  if (channel === 'voice' && (routingMode === 'life' || projectId === voiceArchiveId)) projectId = null;
  let scope = channel === 'voice' ? (projectId ? 'project' : 'memory') : (input.scope ?? 'project');
  if (scope !== 'project' && scope !== 'memory') throw Object.assign(new Error('对话范围无效。'), { statusCode: 400 });
  const historyProjectId=channel==='voice'?voiceArchiveId:projectId,historyScope=channel==='voice'?'project':scope;
  if(input.projectRouting!==undefined&&input.projectRouting!=='auto')throw Object.assign(new Error('项目识别方式无效。'),{statusCode:400});
  // Old history may be grouped under a project. Automatic workbench routing is
  // independent of that storage key, so a new topic can select another project.
  const automaticProjectRouting=input.projectRouting==='auto'&&input.agentRuntime===true&&routingMode==='auto';
  if(automaticProjectRouting){projectId=null;scope='memory';}
  return {
    channel, routingMode, projectId, scope, automaticProjectRouting,
    historyProjectId,
    historyScope,
    directVoiceLife: channel === 'voice' && routingMode === 'life'
  } as const;
}

/** The archive belongs to the saved conversation, not to the next input device.
 * Automatic routing determines business context independently and grants no
 * authority from a conversation's old project/archive key.
 */
export function canContinueConversationHistory(context:ReturnType<typeof conversationChannel>,saved:{scope_type:string;project_id:string|null}|undefined):saved is {scope_type:string;project_id:string|null} {
  if(!saved)return false;
  if(context.automaticProjectRouting) {
    return saved.scope_type==='memory'?saved.project_id==null:saved.scope_type==='project'&&Boolean(saved.project_id);
  }
  return saved.scope_type===context.historyScope&&(saved.project_id??null)===(context.historyProjectId??null);
}
