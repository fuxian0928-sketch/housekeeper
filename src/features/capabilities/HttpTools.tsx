import {FeedbackBanner} from '../../components/FeedbackBanner';
import {useEffect,useState} from 'react';
import {ChevronDown,Plus} from 'lucide-react';
import {api} from '../../api';
import {StyledSelect} from '../../components/ui';
import {CapabilityDialog} from './CapabilityDialog';
import {useWorkbenchActive,useWorkbenchDraftValue} from '../conversations/useWorkbenchTabs';

type Item={id:string;name:string;description:string;url:string;method:string;schema:unknown;hasToken:boolean;toolName:string};
const blank={name:'',description:'',url:'',method:'POST',schema:'{"type":"object","properties":{},"additionalProperties":false}',token:'',clearToken:false};
export function HttpTools({onChange}:{onChange:()=>Promise<void>}) {
  const visible=useWorkbenchActive();
  const [items,setItems]=useState<Item[]>([]),[draft,setDraft]=useState(blank),[editing,setEditing]=useState<string|null>(null);
  const [mode,setMode]=useState<'edit'|'manage'|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[remove,setRemove]=useState<string|null>(null);
  useWorkbenchDraftValue('http-tool-editor',draft,mode==='edit',busy);
  const load=async()=>setItems(await api.get<Item[]>('/capabilities/http'));
  useEffect(()=>{if(!visible)return;let active=true;api.get<Item[]>('/capabilities/http').then(data=>{if(active)setItems(data);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[visible]);
  async function action(work:()=>Promise<unknown>){setBusy(true);setError('');try{await work();await Promise.all([load(),onChange()]);}catch(e){setError(e instanceof Error?e.message:'保存未完成，请重试。');}finally{setBusy(false);}}
  const close=()=>{if(busy)return;setMode(null);setError('');setRemove(null);setDraft(blank);};
  return <section className="cap-http-section">
    <div className="cap-toolbar"><div><h3>自建工具</h3><p>把已有的 API 服务接给希微使用。</p></div><div className="cap-actions">{items.length?<button type="button" className="secondary-button" disabled={busy} onClick={()=>{setMode('manage');setError('');}}>管理自建工具</button>:null}<button type="button" className="primary-button" disabled={busy} onClick={()=>{setDraft(blank);setEditing(null);setMode('edit');setError('');}}><Plus size={13}/>新增 HTTP 工具</button></div></div>
    {error&&!mode?<FeedbackBanner tone="error">{error}</FeedbackBanner>:null}
    {mode?<CapabilityDialog title={mode==='manage'?'管理自建工具':editing?'编辑 HTTP 工具':'新增 HTTP 工具'} busy={busy} onClose={close}>
      {mode==='manage'?<>{error?<FeedbackBanner tone="error">{error}</FeedbackBanner>:null}<ul className="cap-http-items">{items.map(item=><li key={item.id}><div><h3>{item.name}</h3><p>{item.description}</p></div><div className="cap-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>{setEditing(item.id);setDraft({...blank,name:item.name,description:item.description,url:item.url,method:item.method,schema:JSON.stringify(item.schema,null,2)});setMode('edit');setError('');}}>编辑</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>remove===item.id?void action(async()=>{await api.delete(`/capabilities/http/${item.id}`);setRemove(null);}):setRemove(item.id)}>{remove===item.id?'确认删除':'删除'}</button>{remove===item.id?<button type="button" className="secondary-button" disabled={busy} onClick={()=>setRemove(null)}>取消</button>:null}</div></li>)}</ul>{!items.length?<p className="cap-empty">还没有自建工具。</p>:null}</>:<form className="cap-dialog-form" onSubmit={e=>{e.preventDefault();void action(async()=>{let schema:unknown;try{schema=JSON.parse(draft.schema);}catch{throw new Error('参数定义不是有效的 JSON，请对照接口文档检查。');}const body={...draft,schema};await(editing?api.put(`/capabilities/http/${editing}`,body):api.post('/capabilities/http',body));setMode(null);setDraft(blank);});}}>
        <p>填写服务提供方的接口信息，希微才能正确调用。请求由你的服务器发出。</p>
        <label>工具名称<input autoFocus required maxLength={80} disabled={busy} value={draft.name} placeholder="例如：查询天气" onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
        <label>它能做什么<input required maxLength={1000} disabled={busy} value={draft.description} placeholder="例如：查询指定城市未来几天的天气" onChange={e=>setDraft({...draft,description:e.target.value})}/><small>希微根据这段说明，判断什么时候需要调用它。</small></label>
        <label>接口地址<input required type="url" disabled={busy} value={draft.url} placeholder="https://example.com/api/weather" onChange={e=>setDraft({...draft,url:e.target.value})}/><small>从该服务的 API 文档复制接口地址，通常不是网站首页。</small></label>
        <details className="cap-interface-details"><summary>接口细节<span className="cap-meta">{draft.method}</span><ChevronDown size={14}/></summary><div>
          <div className="cap-form-grid"><label>调用方式<StyledSelect value={draft.method} disabled={busy} onChange={e=>setDraft({...draft,method:e.target.value})}>{['GET','POST','PUT','PATCH','DELETE'].map(method=><option key={method} value={method}>{method}</option>)}</StyledSelect><small>按接口文档选择；GET 查询，其余方式发送 JSON。</small></label>
          <label>访问令牌（选填）<input type="password" autoComplete="new-password" disabled={busy} value={draft.token} placeholder={editing?'留空保留已保存的令牌':'接口要求 Bearer 认证时填写'} onChange={e=>setDraft({...draft,token:e.target.value})}/><small>由服务提供方发放，用于验证调用权限；加密保存。</small></label></div>
          {editing?<label className="cap-checkbox"><input type="checkbox" disabled={busy} checked={draft.clearToken} onChange={e=>setDraft({...draft,clearToken:e.target.checked,token:''})}/>清除已保存的令牌</label>:null}
          <label>参数定义<textarea rows={6} spellCheck={false} disabled={busy} value={draft.schema} onChange={e=>setDraft({...draft,schema:e.target.value})}/><small>接口需要城市、日期等信息时，从文档粘贴 JSON Schema。无参数可保留当前内容。</small></label>
        </div></details>
        {error?<FeedbackBanner tone="error">{error}</FeedbackBanner>:null}
        <footer><button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy?'正在保存…':'保存工具'}</button></footer>
      </form>}
    </CapabilityDialog>:null}
  </section>;
}
