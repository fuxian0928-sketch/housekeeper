import {database,nowIso} from '../../db.js';

/** Introductory fields are source material; a newer sourced fact can supersede them. */
export function projectedProfileRows():Array<Record<string,unknown>>{
  const at=nowIso();
  return database.prepare('SELECT * FROM user_profile ORDER BY rowid').all().map(field=>{
    const current=database.prepare(`SELECT current.* FROM memory_sources s JOIN memories original ON original.id=s.memory_id
      JOIN memories current ON current.id=original.id OR (original.fact_key<>'' AND current.fact_key=original.fact_key) OR current.supersedes_id=original.id
      WHERE s.source_type='onboarding' AND s.source_id=? AND current.status='confirmed' AND current.project_id IS NULL
      AND (current.valid_from IS NULL OR current.valid_from<=?) AND (current.valid_until IS NULL OR current.valid_until>=?)
      ORDER BY current.updated_at DESC,current.memory_revision DESC LIMIT 1`).get(String(field.field_key),at,at);
    if(!current||String(field.updated_at)>String(current.updated_at))return field;
    const details=JSON.parse(String(current.details_json??'{}'));
    return{...field,value:typeof details.value==='string'?details.value:String(current.content),source_type:'automatic',updated_at:current.updated_at,memory_id:current.id};
  });
}
