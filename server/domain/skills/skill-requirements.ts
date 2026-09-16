import {database} from '../../db.js';

export function skillRequirements(id:string):string[]{
 database.exec('CREATE TABLE IF NOT EXISTS skill_requirements(skill_id TEXT PRIMARY KEY,tools_json TEXT NOT NULL)');
 return JSON.parse(String(database.prepare('SELECT tools_json FROM skill_requirements WHERE skill_id=?').get(id)?.tools_json??'[]'));
}
