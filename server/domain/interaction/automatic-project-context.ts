import type {DatabaseSync} from 'node:sqlite';
import {database} from '../../db.js';
import {createContextualNavigationService,type NavigationTarget} from './contextual-navigation.js';

type Project={id:string;name:string};
export type AutomaticProjectContext={status:'resolved'|'ambiguous'|'unresolved';candidates:Project[];reason:string};
type Interaction={focus?:NavigationTarget;recentTargets?:NavigationTarget[]};
const normalize=(text:string)=>text.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s·•]+/g,'');

/** A read-only hint. It neither locks a conversation to a project nor authorizes a write. */
export function createAutomaticProjectContext(store:Pick<DatabaseSync,'prepare'>){
  const navigation=createContextualNavigationService(store);
  return (goal:string,interaction?:Interaction):AutomaticProjectContext=>{
    const projects=(store.prepare("SELECT id,name FROM projects WHERE deleted_at IS NULL AND status<>'archived' AND id<>'system-voice-conversations' ORDER BY id LIMIT 501").all() as Project[]).map(({id,name})=>({id,name}));
    const result=(candidates:Project[],reason:string):AutomaticProjectContext=>({status:candidates.length===1?'resolved':candidates.length?'ambiguous':'unresolved',candidates:candidates.slice(0,5),reason});
    if(projects.length>500)return result([],'项目较多，请通过项目查找工具定位名称。');
    const query=normalize(goal),named=projects.filter(project=>{
      const name=normalize(project.name);if(name.length<2)return false;
      if(/^[a-z0-9]+$/i.test(name))return new RegExp(`(^|[^a-z0-9])${name}($|[^a-z0-9])`,'i').test(query);
      return query.includes(name);
    });
    if(named.length)return result(named,named.length===1?'本轮明确提到已有项目；仍需读取实际资料。':'本轮涉及多个同名或不同项目，请按目标核对，写入前确认归属。');
    // A generic question must not silently inherit a project just because its page was open.
    if(!/(?:这个|那个|该|当前|刚才|刚刚|上次|之前).{0,8}(?:项目|任务|文档|资料)|^(?:继续|接着|接下来|刚才那|上次那)/.test(goal.trim()))return result([],'没有明确项目；由 Agent 根据语境按需检索，闲聊不必读取项目。');
    const projectsFor=(target:NavigationTarget)=>{
      const checked=navigation.validateNavigationTarget(target);if(!checked.valid)return [];
      const item=checked.target;
      if(item.kind==='project')return projects.filter(project=>project.id===item.id);
      if(item.kind==='task'){
        const task=store.prepare('SELECT project_id FROM tasks WHERE id=?').get(item.id!);
        return projects.filter(project=>project.id===task?.project_id);
      }
      if(item.kind==='document'){
        const linked=store.prepare('SELECT project_id FROM project_document_links WHERE document_id=? UNION SELECT t.project_id FROM task_document_links l JOIN tasks t ON t.id=l.task_id WHERE l.document_id=?').all(item.id!,item.id!);
        return projects.filter(project=>linked.some(row=>row.project_id===project.id));
      }
      return [];
    };
    const historical=/(?:上次|之前)/.test(goal);
    if(!historical&&interaction?.focus){const focused=projectsFor(interaction.focus);if(focused.length)return result(focused,'根据实际打开对象的项目关联定位；多项目资料需要澄清。');}
    const recent=[...new Map((interaction?.recentTargets??[]).slice(0,20).flatMap(projectsFor).map(project=>[project.id,project])).values()];
    return result(recent,recent.length===1?'根据本段聊天中实际读取的对象定位。':recent.length?'近期读取了多个项目，需要结合聊天内容澄清。':'没有可核实的项目线索，请检索或简短追问。');
  };
}
export const automaticProjectContext=createAutomaticProjectContext(database);
