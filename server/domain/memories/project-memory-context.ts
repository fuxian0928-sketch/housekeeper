import { createHash } from 'node:crypto';
import { database, nowIso } from '../../db.js';
import type { EmbeddingProvider } from '../../providers/embedding-provider.js';
import { getCoreMemorySnapshot, searchRelevantMemories } from './memory-service.js';
import { contextMemoryFromRow, type ContextMemory, type MemoryContext, type MemoryContextProvider, type MemoryContextRequest } from './memory-context.js';

export function projectMemoryProfileRevision(baseUrl: string, model: string, apiKey: string | null) {
  // The credential is hashed only in process and never included in a response/log.
  return createHash('sha256').update(JSON.stringify([baseUrl,model,apiKey,
    database.prepare('PRAGMA data_version').get(),database.prepare('SELECT revision FROM memory_context_revision WHERE id=1').get()])).digest('hex');
}

export function recordProjectMemoryAccess(context: MemoryContext) {
  const ids=[...context.facts,...context.preferences].filter(item=>item.relevantRank!==undefined).map(item=>item.memoryId);
  if(ids.length)database.prepare(`UPDATE memories SET access_count=access_count+1,last_accessed_at=? WHERE id IN (${ids.map(()=>'?').join(',')})`).run(nowIso(),...ids);
}

/** Existing project lexical + FTS + vector retrieval behind the shared contract.
 * Read-only by default. Foreground callers may explicitly retain access analytics.
 * This adapter is not substituted by a lexical prefetch candidate.
 */
export class ProjectMemoryContextProvider implements MemoryContextProvider {
  constructor(private readonly embedding?: EmbeddingProvider | null, private readonly trackAccess = false) {}
  async retrieve(request: MemoryContextRequest): Promise<MemoryContext> {
    request.signal?.throwIfAborted();
    if(request.projectIds.length!==1 || typeof request.projectIds[0]!=='string' || !request.projectIds[0] || request.projectIds[0].length>200) throw Error('MEMORY_PROJECT_SCOPE_REQUIRED');
    const projectId=request.projectIds[0], limit=request.limit??32;
    if(!Number.isSafeInteger(limit)||limit<1||limit>32)throw Error('MEMORY_LIMIT_INVALID');
    const checkProject=()=>{
      if(!database.prepare('SELECT id FROM projects WHERE id=? AND deleted_at IS NULL').get(projectId))throw Error('MEMORY_PROJECT_UNAVAILABLE');
    };
    checkProject();
    const relevant=await searchRelevantMemories(request.query,projectId,this.embedding,Math.min(8,limit),request.signal,{trackAccess:false});
    request.signal?.throwIfAborted();checkProject();
    const core=getCoreMemorySnapshot(projectId,Math.min(18,limit));
    const memories=new Map<string,ContextMemory>();
    core.forEach((row,index)=>memories.set(row.id,{...contextMemoryFromRow(row,true),coreRank:index}));
    relevant.forEach((row,index)=>{
      const previous=memories.get(row.id);
      memories.set(row.id,{...(previous??contextMemoryFromRow(row,false)),relevantRank:index});
    });
    const selected=[...memories.values()].slice(0,limit);
    const context: MemoryContext = {
      facts:selected.filter(item=>!['preference','work_style'].includes(item.memoryType)),
      preferences:selected.filter(item=>['preference','work_style'].includes(item.memoryType)),experiences:[],
      provider:'existing-project-hybrid-v1',retrievedAt:nowIso()
    };
    if(this.trackAccess)recordProjectMemoryAccess(context);
    return context;
  }
}
