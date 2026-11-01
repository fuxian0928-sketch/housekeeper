import {createHash} from 'node:crypto';
import {database,nowIso} from '../../db.js';
import {inspectSkill} from './skill-workbench.js';
import {listManagedSkills} from './skill-manager.js';
import {listSkillTools} from './skill-tool-registry.js';

function store(){database.exec('CREATE TABLE IF NOT EXISTS skill_health_checks(skill_id TEXT PRIMARY KEY,updated_at TEXT NOT NULL,tool_state TEXT NOT NULL,result_json TEXT NOT NULL)');}
function toolState(){return createHash('sha256').update(JSON.stringify(listSkillTools().map(t=>[t.name,t.enabled,t.policy,t.parameters]))).digest('hex');}
type Health=Awaited<ReturnType<typeof inspectSkill>>&{checkedAt:string;stale?:boolean};
export function readSkillHealthChecks():Map<string,Health> {
  store();const skills=new Map(listManagedSkills().map(skill=>[skill.id,skill])),state=toolState();
  return new Map(database.prepare('SELECT * FROM skill_health_checks').all().flatMap(row=>{
    try{return [[String(row.skill_id),{...JSON.parse(String(row.result_json)),stale:row.updated_at!==skills.get(String(row.skill_id))?.updatedAt||row.tool_state!==state}]] as Array<[string,Health]>;}catch{return [];}
  }));
}
/** Installation checks inspect rules/dependencies only. They never run a skill or call its tools. */
export async function checkSkillHealth(id:string,complete?:Parameters<typeof inspectSkill>[1]):Promise<Health> {
  const before=listManagedSkills().find(item=>item.id===id),state=toolState();
  const result={...await inspectSkill(id,complete),checkedAt:nowIso(),stale:before?.updatedAt!==listManagedSkills().find(item=>item.id===id)?.updatedAt||state!==toolState()};
  store();database.prepare('INSERT INTO skill_health_checks VALUES(?,?,?,?) ON CONFLICT(skill_id) DO UPDATE SET updated_at=excluded.updated_at,tool_state=excluded.tool_state,result_json=excluded.result_json')
    .run(id,before?.updatedAt??'',state,JSON.stringify(result));
  return result;
}

/** First-party static dependency checks run at boot, never tool probes or LLM calls. */
export async function checkBundledSkillHealth() {
  const checks=readSkillHealthChecks(),errors:Array<{name:string;message:string}>=[];
  for(const skill of listManagedSkills().filter(item=>item.sourceType==='bundled'&&item.status==='installed')) {
    if(checks.has(skill.id)&&!checks.get(skill.id)?.stale)continue;
    try { await checkSkillHealth(skill.id); }
    catch(error) { errors.push({name:skill.name,message:error instanceof Error?error.message:'内置技能检查失败'}); }
  }
  return errors;
}
