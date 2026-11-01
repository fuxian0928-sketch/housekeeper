import {createHash} from 'node:crypto';
import {database} from '../../db.js';
import {safeMemoryText} from './work-memory.js';

type Row = Record<string, unknown>;
export type MemoryGraphNode = {
  id: string; kind: 'memory'|'event'|'group'; title: string; content: string;
  state: 'current'|'historical'|'recorded'; createdAt: string; updatedAt: string;
  projectId: string|null; projectName: string; memoryType?: string; revision?: number;
  source?: {kind: 'document'|'message'|'event'|'run'; id: string};
};
export type MemoryGraphEdge = {id: string; source: string; target: string; kind: 'evidence'|'sequence'|'updates'|'conflict'|'belongs'; label: string};
export type MemoryGraph = {
  revision: string; updatedAt: string|null; nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  projects: {id: string; name: string}[];
  stats: {totalMemories: number; memories: number; events: number; historical: number; connections: number};
  limited: boolean;
};
const parse = (value: unknown): Row => {try {const result=JSON.parse(String(value??'{}'));return result&&typeof result==='object'&&!Array.isArray(result)?result:{};} catch {return {};}};
const clean = (value: unknown, limit=900) => safeMemoryText(String(value??''),limit);
const title = (value: unknown) => clean(value,120).replace(/[#*`\n]+/g,' ').trim().slice(0,38);
const list = (ids: string[]) => ids.map(()=>'?').join(',');

/** A read-only projection of the ledger and real sources. Graph layout is never a memory writer. */
export function buildMemoryGraph(input: {query?: string; projectId?: string|null; history?: boolean; limit?: number} = {}): MemoryGraph {
  database.exec('SAVEPOINT memory_graph_read');
  try {
    const result=readGraph(input);
    database.exec('RELEASE memory_graph_read');
    return result;
  } catch(error) {database.exec('ROLLBACK TO memory_graph_read');database.exec('RELEASE memory_graph_read');throw error;}
}
function readGraph(input: Parameters<typeof buildMemoryGraph>[0]): MemoryGraph {
  const at=new Date().toISOString(), query=(input?.query??'').normalize('NFKC').trim().slice(0,120);
  const projectId=input?.projectId?.trim()||null, history=Boolean(input?.history);
  const limit=Math.max(1,Math.min(120,Math.floor(Number(input?.limit)||80)));
  const projects=database.prepare('SELECT id,name FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 200').all().map(row=>({id:String(row.id),name:clean(row.name,120)}));
  const scope=`(m.project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.id=m.project_id AND p.deleted_at IS NULL))
    AND NOT EXISTS(SELECT 1 FROM memory_forgetting f WHERE f.memory_id=m.id)
    AND m.status IN (${history?"'confirmed','superseded'":"'confirmed'"})
    AND (m.valid_from IS NULL OR m.valid_from<=?) ${history?'':"AND (m.valid_until IS NULL OR m.valid_until>?)"}
    ${projectId?'AND m.project_id=?':''}
    ${query?`AND (instr(lower(m.content),lower(?))>0 OR instr(lower(m.source_label),lower(?))>0
      OR EXISTS(SELECT 1 FROM memory_sources s WHERE s.memory_id=m.id AND instr(lower(s.excerpt),lower(?))>0))`:''}`;
  const parameters: (string|number)[]=[at,...(history?[]:[at]),...(projectId?[projectId]:[]),...(query?[query,query,query]:[])];
  const total=Number(database.prepare(`SELECT COUNT(*) AS n FROM memories m WHERE ${scope}`).get(...parameters)?.n??0);
  const memories=database.prepare(`SELECT m.*,p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id=m.project_id WHERE ${scope}
    ORDER BY m.status='confirmed' DESC,m.updated_at DESC,m.id LIMIT ?`).all(...parameters,limit) as Row[];
  if(history){
    const known=new Set(memories.map(row=>String(row.id)));
    let frontier=[...memories];
    for(let depth=0;depth<2&&frontier.length;depth++){
      const next: Row[]=[];
      for(const row of frontier){
        if(!row.supersedes_id||known.has(String(row.supersedes_id)))continue;
        const parent=database.prepare(`SELECT m.*,p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id=m.project_id WHERE m.id=?
          AND m.status='superseded' AND NOT EXISTS(SELECT 1 FROM memory_forgetting f WHERE f.memory_id=m.id)
          AND COALESCE(m.project_id,'')=COALESCE(?,'') AND (m.project_id IS NULL OR p.deleted_at IS NULL)`).get(String(row.supersedes_id),row.project_id?String(row.project_id):null);
        if(parent){known.add(String(parent.id));memories.push(parent);next.push(parent);}
      }
      frontier=next;
    }
  }
  const nodes=new Map<string,MemoryGraphNode>(), edges=new Map<string,MemoryGraphEdge>(), eventGroups=new Map<string,MemoryGraphNode[]>();
  let clipped=total>memories.length;
  const addNode=(node: MemoryGraphNode) => {if(nodes.has(node.id))return true;if(nodes.size>=360){clipped=true;return false;}nodes.set(node.id,node);return true;};
  const edge=(source: string,target: string,kind: MemoryGraphEdge['kind'],label: string) => {
    if(source===target||!nodes.has(source)||!nodes.has(target))return;
    const id=JSON.stringify([source,target,kind]);edges.set(id,{id,source,target,kind,label});
  };
  const group=(node: MemoryGraphNode) => {
    const id=`group:${node.projectId??'personal'}`;
    addNode({id,kind:'group',state:'recorded',title:node.projectName||'日常与偏好',content:node.projectId?'这个项目中的事件与记忆。':'关于你的偏好、工作方式与日常经历。',projectId:node.projectId,projectName:node.projectName,createdAt:'',updatedAt:''});
    edge(id,node.id,'belongs',node.projectId?'同属项目':'日常关联');
  };
  for(const row of memories) {
    const displayTitle=parse(row.details_json).displayTitle;
    const node: MemoryGraphNode={id:`memory:${row.id}`,kind:'memory',title:typeof displayTitle==='string'?title(displayTitle):title(row.content),content:clean(row.content),
      state:row.status==='superseded'||row.valid_until&&String(row.valid_until)<=at?'historical':'current',
      projectId:row.project_id?String(row.project_id):null,projectName:clean(row.project_name,120),
      createdAt:String(row.created_at),updatedAt:String(row.updated_at),memoryType:String(row.memory_type),revision:Number(row.memory_revision??1)};
    addNode(node);group(node);
  }
  const forgottenSource=(id: string) => Boolean(database.prepare(`SELECT 1 FROM memory_forgetting f JOIN memories m ON m.id=f.memory_id
    WHERE m.source_id=? UNION ALL SELECT 1 FROM memory_forgetting f JOIN memory_sources s ON s.memory_id=f.memory_id WHERE s.source_id=? LIMIT 1`).get(id,id));
  const sourceCache=new Map<string,MemoryGraphNode|null>();
  const sourceNode=(source: Row, observation?: Row): MemoryGraphNode|null => {
    const metadata=parse(observation?.metadata_json), sourceId=String(source.source_id??observation?.source_id??'');
    const type=String(source.source_type??observation?.source_type??'event'), cacheKey=`${type}:${sourceId||observation?.id}`;
    if(sourceCache.has(cacheKey))return sourceCache.get(cacheKey)!;
    if(sourceId&&forgottenSource(sourceId)){sourceCache.set(cacheKey,null);return null;}
    let record: Row|undefined, sourceRef: MemoryGraphNode['source'], entityKey='';
    let id=`trace:${observation?.id??cacheKey}`, heading=title(source.source_label??observation?.source_label), content=clean(source.excerpt??observation?.content);
    let createdAt=String(observation?.created_at??source.created_at??''), updatedAt=createdAt;
    let owner=observation?.project_id?String(observation.project_id):null;
    if(type==='event') {
      record=database.prepare('SELECT * FROM events WHERE id=?').get(sourceId);
      if(record){id=`event:${record.id}`;heading=title(record.title);content=clean(record.detail)||content;sourceRef={kind:'event',id:String(record.id)};entityKey=record.object_id?`object:${record.object_type}:${record.object_id}`:'';}
    } else if(type==='conversation') {
      const runId=metadata.runId??(sourceId.startsWith('agent:')?sourceId.slice(6):null);
      if(runId){
        record=database.prepare('SELECT id,project_id,goal,status,created_at,updated_at FROM agent_runs WHERE id=?').get(String(runId));
        if(record){id=`run:${record.id}`;heading=title(record.goal);content=clean(record.goal)+'\n执行状态：'+clean(record.status,60);sourceRef={kind:'run',id:String(record.id)};entityKey=`run:${record.id}`;}
      } else {
        record=database.prepare('SELECT m.*,c.project_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?').get(sourceId);
        if(record){id=`message:${record.id}`;heading=title(record.content);content=clean(record.content);sourceRef={kind:'message',id:String(record.id)};}
      }
    } else if(type==='document') {
      const docId=String(metadata.documentId??sourceId);
      record=database.prepare('SELECT id,title,indexed_at AS created_at,modified_at FROM knowledge_documents WHERE id=?').get(docId);
      if(record){id=`document-source:${observation?.id??docId}`;heading=title(record.title);sourceRef={kind:'document',id:String(record.id)};}
    }
    if(record){if('project_id' in record)owner=record.project_id?String(record.project_id):null;createdAt=String(record.created_at??createdAt);updatedAt=String(record.updated_at??record.modified_at??createdAt);}
    if(projectId&&owner!==projectId || owner&&!projects.some(p=>p.id===owner)){sourceCache.set(cacheKey,null);return null;}
    if(!heading&&!content){sourceCache.set(cacheKey,null);return null;}
    const node: MemoryGraphNode={id,kind:'event',title:heading||'来源记录',content,state:'recorded',createdAt,updatedAt,projectId:owner,projectName:projects.find(p=>p.id===owner)?.name??'',...(sourceRef?{source:sourceRef}:{})};
    sourceCache.set(cacheKey,node);
    if(addNode(node)){
      group(node);
      if(entityKey){const bucket=eventGroups.get(entityKey)??[];if(!bucket.some(item=>item.id===id))bucket.push(node);eventGroups.set(entityKey,bucket);}
      return node;
    }
    return null;
  };
  const ids=memories.map(row=>String(row.id));
  const sources=ids.length?database.prepare(`SELECT s.*,o.project_id,o.metadata_json,o.content AS observation_content,o.created_at AS observed_at,
    row_number() OVER(PARTITION BY s.memory_id ORDER BY s.created_at DESC,s.observation_id) AS rank
    FROM memory_sources s JOIN memory_observations o ON o.id=s.observation_id WHERE s.memory_id IN (${list(ids)})`).all(...ids).filter(row=>Number(row.rank)<=3):[];
  for(const row of memories) {
    const id=`memory:${row.id}`, linked=sources.filter(source=>source.memory_id===row.id);
    for(const source of linked){
      const obs={id:source.observation_id,project_id:source.project_id,metadata_json:source.metadata_json,content:source.observation_content,created_at:source.observed_at,source_type:source.source_type,source_id:source.source_id,source_label:source.source_label};
      const event=sourceNode(source,obs);if(event)edge(event.id,id,'evidence','形成这条记忆');
    }
    if(!linked.length&&row.source_id){
      const event=sourceNode({source_type:row.source_type,source_id:row.source_id,source_label:row.source_label,excerpt:row.source_excerpt,created_at:row.created_at}, {id:`legacy:${row.id}`,project_id:row.project_id,created_at:row.created_at});
      if(event)edge(event.id,id,'evidence','记忆来源');
    }
    if(row.supersedes_id)edge(`memory:${row.supersedes_id}`,id,'updates','更新为');
    const contradictions=(()=>{try{return JSON.parse(String(row.contradicts_json??'[]'));}catch{return [];}})();
    if(Array.isArray(contradictions))for(const other of contradictions)if(typeof other==='string')edge(`memory:${other}`,id,'conflict','有待核对的差异');
    if(history){
      let previous=id,seen=new Set([String(row.content)]),count=0;
      for(const version of database.prepare('SELECT * FROM memory_history WHERE memory_id=? ORDER BY revision DESC LIMIT 16').all(String(row.id))){
        const snapshot=parse(version.snapshot_json);if(!snapshot.content||seen.has(String(snapshot.content)))continue;
        seen.add(String(snapshot.content));const historic: MemoryGraphNode={...nodes.get(id)!,id:`version:${row.id}:${version.revision}`,state:'historical',title:title(snapshot.content),content:clean(snapshot.content),revision:Number(version.revision),updatedAt:String(version.recorded_at)};
        if(addNode(historic)){edge(historic.id,previous,'updates',version.change_kind==='corrected'?'纠正为':'更新为');previous=historic.id;}
        if(++count>=2)break;
      }
    }
  }
  const recent=database.prepare(`SELECT e.* FROM events e JOIN projects p ON p.id=e.project_id WHERE p.deleted_at IS NULL
    ${projectId?'AND e.project_id=?':''} ${query?'AND (instr(lower(e.title),lower(?))>0 OR instr(lower(e.detail),lower(?))>0)':''}
    AND COALESCE(e.object_type,'')<>'memory' ORDER BY e.created_at DESC,e.id LIMIT 40`).all(...(projectId?[projectId]:[]),...(query?[query,query]:[]));
  for(const row of recent)sourceNode({source_type:'event',source_id:row.id,created_at:row.created_at},row);
  for(const bucket of eventGroups.values()){
    bucket.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    for(let i=1;i<bucket.length;i++)if(bucket[i-1].projectId===bucket[i].projectId)edge(bucket[i-1].id,bucket[i].id,'sequence','同一事务的后续记录');
  }
  const visible=[...nodes.values()], connections=[...edges.values()];
  const updatedAt=visible.map(node=>node.updatedAt).filter(Boolean).sort().at(-1)??null;
  const value={nodes:visible,edges:connections,projects,stats:{totalMemories:total,memories:visible.filter(n=>n.kind==='memory'&&n.state==='current').length,events:visible.filter(n=>n.kind==='event').length,historical:visible.filter(n=>n.state==='historical').length,connections:connections.length},limited:clipped};
  const revision=createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {revision,updatedAt,...value};
}
