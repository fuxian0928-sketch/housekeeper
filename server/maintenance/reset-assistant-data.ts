import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

// Offline maintenance only: stop writers and verify a recoverable backup first.
// Unknown tables fail closed so a future configuration store is never erased
// merely because it was not present when this reset was written.
const preserved=new Set([
  'app_settings','schema_migrations','managed_skills','skill_requirements',
  'mcp_connections','custom_http_tools','computer_devices','central_devices',
  'memory_context_revision','assistant_persona','assistant_persona_history',
  'voice_config','voice_devices','xiaozhi_integration'
]);
const userData=new Set(`action_proposals agent_artifacts agent_invocations agent_run_events agent_runs
capability_tool_runs central_device_commands central_document_blobs central_document_conflicts
central_document_replicas central_document_versions central_local_sync_state central_source_documents
central_vault_members central_vaults computer_commands conversations documents events external_tool_dispatches
external_tool_resolutions generated_files github_repo_cache knowledge_chunks knowledge_chunks_fts knowledge_document_relations
knowledge_document_versions knowledge_documents knowledge_vectors memories memories_fts memory_extraction_items
memory_forgetting memory_history memory_index_jobs memory_observation_sources memory_observations
memory_pending_claims memory_reflections memory_sources memory_summaries memory_vectors message_archive_fts
message_suggestions messages obsidian_write_requests office_document_imports project_document_links
project_summary_versions projects prototype_versions prototypes rag_active rag_children rag_children_fts
rag_embedding_state rag_embeddings rag_generations rag_jobs rag_parents rag_sentence_vectors self_diagnostics
skill_health_checks skill_install_events skill_tool_executions skill_workbench_runs sync_applied_operations
sync_conflicts sync_entity_aliases sync_entity_versions sync_operations task_document_links task_history
tasks user_profile voice_session_handoffs voice_session_scopes voice_turns xiaozhi_mcp_events`.split(/\s+/));

function quote(name:string){return '"'+name.replaceAll('"','""')+'"';}
export function assistantResetPlan(db:DatabaseSync){
  const tables=db.prepare('PRAGMA main.table_list').all().filter(row=>row.schema==='main'&&row.type!=='shadow'&&!String(row.name).startsWith('sqlite_')&&!/^(?:knowledge|memory)_vectors_vector_chunks\d+$/.test(String(row.name)));
  const unknown=tables.filter(row=>!preserved.has(String(row.name))&&!userData.has(String(row.name))).map(row=>String(row.name));
  if(unknown.length)throw Error(`初始化前需审查未分类的数据表：${unknown.join(', ')}`);
  return tables.filter(row=>userData.has(String(row.name))).map(row=>({name:String(row.name),virtual:row.type==='virtual',rows:Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(String(row.name))}`).get()?.n)}));
}

export function resetAssistantData(db:DatabaseSync,input:{backupVerified:boolean;persona:Record<string,unknown>;disabledWorkTools:string[]}){
  if(!input.backupVerified)throw Error('请先验证备份，再执行初始化。');
  if(typeof input.persona.identity!=='string'||!input.persona.identity||typeof input.persona.personality!=='string')throw Error('缺少初始化后的助理人设。');
  const plan=assistantResetPlan(db),foreignKeys=Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys),at=new Date().toISOString(),generation=randomUUID();
  db.exec('PRAGMA foreign_keys=OFF');
  try{
    db.exec('BEGIN IMMEDIATE');
    // Virtual parents own their shadow storage. Never delete shadow tables.
    const deletionOrder=[...plan].sort((a,b)=>Number(b.virtual)-Number(a.virtual));
    for(const table of deletionOrder)db.exec(`DELETE FROM ${quote(table.name)}`);
    // Delete triggers can create forgetting receipts or refresh derived rows.
    // A second pass empties those too, while their source tables are now empty.
    for(const table of deletionOrder)db.exec(`DELETE FROM ${quote(table.name)}`);
    db.exec('DELETE FROM assistant_persona; DELETE FROM assistant_persona_history');
    const profile=JSON.stringify(input.persona);
    db.prepare('INSERT INTO assistant_persona(id,revision,profile_json,updated_at) VALUES(1,1,?,?)').run(profile,at);
    db.prepare('INSERT INTO assistant_persona_history(revision,profile_json,created_at) VALUES(1,?,?)').run(profile,at);
    db.prepare('INSERT INTO memory_context_revision(id,revision) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision').run(generation);
    // Detach old libraries and stop imports; leave external original files alone.
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'sync_seeded_%' OR key IN ('sync_last_run_at','sync_last_error','sync_importing','vault_last_scanned_at') OR key LIKE 'tool_enabled:%prototype%' OR key LIKE 'tool_policy:%prototype%'").run();
    const setting=db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at');
    for(const [key,value] of Object.entries({assistant_scope:'information',vault_path:'',sync_enabled:'0',device_sync_suspended:'1',assistant_data_generation:generation,assistant_reset_at:at,memory_auto_capture:'1',memory_auto_apply:'1',memory_auto_confirm:'1'}))setting.run(key,value,at);
    for(const tool of input.disabledWorkTools)setting.run(`tool_enabled:${tool}`,'0',at);
    db.exec('UPDATE managed_skills SET use_count=0,last_used_at=NULL');
    const violations=db.prepare('PRAGMA foreign_key_check').all();
    if(violations.length)throw Error('初始化后的数据关联检查未通过，操作已回滚。');
    if(assistantResetPlan(db).some(table=>table.rows>0))throw Error('仍有使用数据残留，初始化已回滚。');
    db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  finally{db.exec(`PRAGMA foreign_keys=${foreignKeys?'ON':'OFF'}`);}
  return {generation,resetAt:at,tables:plan,remainingUserRows:assistantResetPlan(db).reduce((sum,table)=>sum+table.rows,0),preservedConfiguration:true};
}
