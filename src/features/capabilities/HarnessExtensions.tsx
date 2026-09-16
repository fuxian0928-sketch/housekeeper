import { StyledSelect } from './../../components/ui';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { ToolParameters } from './ToolParameters';

type Connection={id:string;name:string;url:string;transport:'http'|'sse';enabled:boolean;hasToken:boolean;toolCount:number;checkedAt:string|null};
type Tool={name:string;description:string;mode:string;enabled:boolean;policy?:string;parameters:string};
const blank={name:'',url:'',transport:'http' as 'http'|'sse',token:'',clearToken:false};
const errorText=(e:unknown)=>e instanceof Error?e.message:'操作失败，请重试。';

export function McpConnections({onChange,tools}:{onChange:()=>Promise<void>;tools:Tool[]}){
  const [items,setItems]=useState<Connection[]>([]),[draft,setDraft]=useState(blank),[editing,setEditing]=useState<string|null>(null),[open,setOpen]=useState(false);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[remove,setRemove]=useState<string|null>(null);
  const load=async()=>setItems(await api.get<Connection[]>('/capabilities/mcp'));
  useEffect(()=>{let active=true;api.get<Connection[]>('/capabilities/mcp').then(data=>{if(active)setItems(data);}).catch(e=>{if(active)setError(errorText(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  async function act(work:()=>Promise<unknown>,message:string){setBusy(true);setError('');setNotice('');try{await work();await Promise.all([load(),onChange()]);setNotice(message);}catch(e){setError(errorText(e));}finally{setBusy(false);}}
  return <div>
    <div className="cap-toolbar"><div><h3>外部服务 <span className="cap-meta">{items.length}</span></h3><p>连接服务后，小E可使用它提供的工具。</p></div><button type="button" className="primary-button" disabled={busy} onClick={()=>{setDraft(blank);setEditing(null);setOpen(true);}}>添加 MCP 连接</button></div>
    <details className="cap-help"><summary>支持的连接方式</summary><p>支持 Streamable HTTP、SSE 与 Bearer 令牌；不支持本机命令、OAuth 登录或 WebSocket。服务地址须能从小E服务器访问，localhost 指服务器本机。</p></details>
    {error&&<p role="alert" className="cap-error">{error} <button type="button" className="secondary-button" disabled={busy} onClick={()=>void act(load,'已刷新')}>重新加载</button></p>}
    {notice&&<p role="status" className="cap-notice">{notice}</p>}
    {open&&<form className="cap-editor" onSubmit={e=>{e.preventDefault();void act(async()=>{await (editing?api.put(`/capabilities/mcp/${editing}`,draft):api.post('/capabilities/mcp',draft));setDraft(blank);setOpen(false);},'连接已保存，点击“测试连接”获取工具。');}}>
      <h3>{editing?'编辑连接':'添加连接'}</h3>
      <div className="cap-form-grid"><label>连接名称<input placeholder="例如：团队知识库" required maxLength={80} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
      <label>服务地址<input required type="url" value={draft.url} placeholder="https://服务域名/mcp" onChange={e=>setDraft({...draft,url:e.target.value})}/></label>
      <label>连接协议<StyledSelect value={draft.transport} onChange={e=>setDraft({...draft,transport:e.target.value as 'http'|'sse'})}><option value="http">Streamable HTTP</option><option value="sse">SSE（旧版服务）</option></StyledSelect></label>
      <label>认证令牌（选填）<input type="password" autoComplete="new-password" maxLength={8192} value={draft.token} placeholder={editing?'留空保留原令牌':'服务不要求认证时留空'} onChange={e=>setDraft({...draft,token:e.target.value})}/></label></div>
      {editing&&<label className="cap-checkbox"><input type="checkbox" checked={draft.clearToken} onChange={e=>setDraft({...draft,clearToken:e.target.checked,token:''})}/>清除已保存的令牌</label>}
      <p className="cap-hint">认证令牌加密保存。编辑时留空保留原令牌。</p>
      <div className="cap-actions"><button type="submit" className="primary-button" disabled={busy}>保存连接</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>{setOpen(false);setDraft(blank);}}>取消</button></div>
    </form>}
    {loading?<p role="status">正在加载连接…</p>:!items.length?<p className="cap-empty">暂无连接。添加服务地址后，测试连接以获取工具。</p>:<ul className="cap-list">{items.map(item=><li key={item.id}><div><h3>{item.name}</h3><p>{item.url}</p><small>{item.enabled?'已启用':'已停用'} · {item.transport==='http'?'Streamable HTTP':'SSE'} · {item.hasToken?'已配置令牌':'无令牌'} · {item.toolCount} 个工具</small><p>{item.checkedAt?`上次连接成功：${new Date(item.checkedAt).toLocaleString('zh-CN')}`:'尚未验证连接'}</p>
      <details className="cap-help"><summary>开放给小E的工具</summary><div className="cap-dependency-list">{tools.filter(t=>t.name.startsWith(`mcp_${item.id}_`)).map(t=><label key={t.name} className="cap-checkbox"><input type="checkbox" disabled={busy} checked={t.enabled} onChange={e=>void act(()=>api.patch(`/skills/tools/${encodeURIComponent(t.name)}/enabled`,{enabled:e.target.checked}),'工具开放状态已更新')}/>{t.description}</label>)}</div>{!item.toolCount&&<p>先测试连接，再选择工具。</p>}</details>{remove===item.id&&<div><p>删除后将移除连接、令牌和工具配置，历史调用记录保留。</p><div className="cap-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>void act(async()=>{await api.delete(`/capabilities/mcp/${item.id}`);setRemove(null);},'连接已删除')}>确认删除</button><button type="button" className="secondary-button" onClick={()=>setRemove(null)}>取消删除</button></div></div>}
    </div><div className="cap-actions"><button type="button" className="secondary-button" disabled={busy||!item.enabled} onClick={()=>void act(()=>api.post(`/capabilities/mcp/${item.id}/test`),'连接成功，工具目录已更新')}>{busy?'处理中…':'测试连接'}</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>{setEditing(item.id);setDraft({...blank,name:item.name,url:item.url,transport:item.transport});setOpen(true);}}>编辑</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>void act(()=>api.patch(`/capabilities/mcp/${item.id}/enabled`,{enabled:!item.enabled}),item.enabled?'连接已停用':'连接已启用')}>{item.enabled?'停用':'启用'}</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>setRemove(item.id)}>删除</button></div></li>)}</ul>}
  </div>;
}

export function ToolTestBench({tools,onChange}:{tools:Tool[];onChange:()=>Promise<void>}){
  const [name,setName]=useState(''),[args,setArgs]=useState('{}'),[project,setProject]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[result,setResult]=useState(''),[error,setError]=useState('');
  const [projects,setProjects]=useState<Array<{id:string;name:string}>>([]),[projectError,setProjectError]=useState('');
  useEffect(()=>{let active=true;api.get<Array<{id:string;name:string}>>('/projects').then(data=>{if(active)setProjects(data);}).catch(e=>{if(active)setProjectError(errorText(e));});return()=>{active=false;};},[]);
  const tool=tools.find(t=>t.name===name),requiresConfirm=tool?.mode==='write'||tool?.policy==='confirm';
  return <form className="cap-editor" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');setResult('');try{const argumentsValue=JSON.parse(args);if(!argumentsValue||typeof argumentsValue!=='object'||Array.isArray(argumentsValue))throw new Error('参数必须是 JSON 对象。');const response=await api.post<{result:unknown;truncated:boolean}>('/capabilities/test',{tool:name,arguments:argumentsValue,projectId:project.trim()||null,confirm:confirmed});setResult(JSON.stringify(response.result,null,2)+(response.truncated?'\n（结果较长，已截断显示）':''));await onChange();}catch(e){setError(errorText(e));await onChange().catch(()=>{});}finally{setBusy(false);}}}>
    <h3>测试工具</h3><p className="cap-hint">测试会真实执行工具，结果同步记录到“执行记录”。</p>
    <div className="cap-form-grid"><label>选择工具<StyledSelect required value={name} disabled={busy} onChange={e=>{setName(e.target.value);setConfirmed(false);setResult('');setError('');setArgs('{}');}}><option value="">请选择工具</option>{tools.map(t=><option key={t.name} value={t.name} disabled={!t.enabled}>{t.description}{t.enabled?'':'（已停用）'}</option>)}</StyledSelect></label>
    <label>执行范围<StyledSelect value={project} disabled={busy} onChange={e=>{setProject(e.target.value);setConfirmed(false);}}><option value="">全局（不限定项目）</option>{projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</StyledSelect></label></div>{projectError&&<p role="alert" className="cap-error">项目列表加载失败：{projectError}</p>}
    {tool&&<details className="cap-help" key={tool.name} open><summary>参数与必填项</summary><ToolParameters value={tool.parameters}/></details>}<label>工具参数（JSON）<textarea required rows={8} spellCheck={false} value={args} disabled={busy} onChange={e=>{setArgs(e.target.value);setConfirmed(false);}}/></label>
    {requiresConfirm&&<label className="cap-checkbox"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>我确认执行此工具，可能会真实修改数据或调用外部服务。</label>}
    <div className="cap-actions"><button type="submit" className="primary-button" disabled={busy||!tool?.enabled||(requiresConfirm&&!confirmed)}>{busy?'正在执行…':'执行测试'}</button></div>
    {error&&<p role="alert" className="cap-error">{error}</p>}{result&&<div role="status"><h3>执行成功</h3><pre className="cap-result">{result}</pre></div>}
  </form>;
}

export function SkillVersions({id,onChange}:{id:string;onChange:()=>Promise<void>}){
  const [versions,setVersions]=useState<Array<{id:string;version:string;createdAt:string}>>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState(''),[notice,setNotice]=useState('');
  const load=async()=>setVersions(await api.get<typeof versions>(`/skills/${encodeURIComponent(id)}/versions`));
  useEffect(()=>{let active=true;setBusy(true);api.get<typeof versions>(`/skills/${encodeURIComponent(id)}/versions`).then(v=>{if(active)setVersions(v);}).catch(e=>{if(active)setError(errorText(e));}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[id]);
  return <div className="cap-editor"><h3>技能历史版本</h3><p className="cap-hint">恢复技能规则与文件，不撤销已经执行的操作。</p>{error&&<p role="alert" className="cap-error">{error}</p>}{notice&&<p role="status" className="cap-notice">{notice}</p>}
    {busy&&<p role="status">正在处理版本…</p>}
    <label>选择历史版本<StyledSelect value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}><option value="">请选择要恢复的版本</option>{versions.map(v=><option key={v.id} value={v.id}>版本 {v.version} · {new Date(v.createdAt).toLocaleString('zh-CN')}</option>)}</StyledSelect></label>
    <button className="secondary-button" type="button" disabled={busy||!selected} onClick={async()=>{setBusy(true);setError('');setNotice('');try{await api.post(`/skills/${encodeURIComponent(id)}/rollback`,{revisionId:selected});await Promise.all([load(),onChange()]);setSelected('');setNotice('已恢复所选版本，当前启停状态保持不变。');}catch(e){setError(errorText(e));}finally{setBusy(false);}}}>恢复所选版本</button>
  </div>;
}
