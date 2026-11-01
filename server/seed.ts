import {randomUUID} from 'node:crypto';
import {database,nowIso} from './db.js';

// Optional synthetic example only. Production startup leaves the database empty.
export function seedDatabase(){
  const count=database.prepare('SELECT COUNT(*) AS count FROM projects').get() as {count:number};
  if(count.count)return;
  const id=randomUUID(),at=nowIso();
  database.prepare(`INSERT INTO projects(id,name,summary,status,priority,vault_path,source_path,created_at,updated_at) VALUES(?,?,?,'active','medium','','',?,?)`)
    .run(id,'示例项目','用于本机开发的合成示例，不代表用户的真实工作。',at,at);
}
