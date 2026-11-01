import {database} from '../../db.js';
import {bundledSkillDefinition} from './bundled-skills.js';

export function skillRequirements(id:string):string[]{
 database.exec('CREATE TABLE IF NOT EXISTS skill_requirements(skill_id TEXT PRIMARY KEY,tools_json TEXT NOT NULL)');
 const row=database.prepare('SELECT name,source_type FROM managed_skills WHERE id=?').get(id);
 const bundled=row?.source_type==='bundled'?bundledSkillDefinition(String(row.name)):undefined;
 const configured=JSON.parse(String(database.prepare('SELECT tools_json FROM skill_requirements WHERE skill_id=?').get(id)?.tools_json??'[]')) as string[];
 return [...new Set([...(bundled?.requiredTools??[]),...configured])];
}
