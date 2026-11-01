import {FeedbackBanner} from '../../components/FeedbackBanner';
import {useEffect,useState} from 'react';
import {api} from '../../api';
type Operation={fingerprint:string;toolName:string;attemptId:string;status:string;updatedAt:string;canResolve:boolean};
export function UncertainOperations({tools}:{tools:Array<{name:string;description:string}>}){
 const [items,setItems]=useState<Operation[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [selected,setSelected]=useState<Operation|null>(null),[outcome,setOutcome]=useState(''),[note,setNote]=useState(''),[confirmed,setConfirmed]=useState(false);
 useEffect(()=>{let live=true;api.get<Operation[]>('/capabilities/uncertain').then(rows=>{if(live)setItems(rows);}).catch(e=>{if(live)setError(e instanceof Error?e.message:'读取待核对操作失败。');}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[]);
 async function refresh(){setBusy(true);setError('');try{setItems(await api.get<Operation[]>('/capabilities/uncertain'));}catch(e){setError(e instanceof Error?e.message:'刷新失败，请重试。');}finally{setBusy(false);}}
 async function resolve(){if(!selected)return;setBusy(true);setError('');setNotice('');try{
  await api.post('/capabilities/uncertain/resolve',{fingerprint:selected.fingerprint,attemptId:selected.attemptId,outcome,note,confirmed});
  setSelected(null);setNotice('核对结果已记录。没有重新执行操作。');
  setItems(await api.get<Operation[]>('/capabilities/uncertain'));
 }catch(e){setError(e instanceof Error?e.message:'未能保存核对结果，请刷新状态。');}finally{setBusy(false);}}
 return <section className="cap-resolution" aria-label="待核对的外部操作">
  <div className="cap-toolbar"><div><h3>待核对操作</h3><p>请求可能已在外部服务执行。核对后记录结果，不会自动重试。</p></div><button type="button" className="secondary-button" disabled={busy||loading} onClick={()=>void refresh()}>刷新状态</button></div>
  {error&&<FeedbackBanner tone="error">{error}</FeedbackBanner>}{notice&&<FeedbackBanner tone="success">{notice}</FeedbackBanner>}
  {loading?<p role="status">正在读取操作状态…</p>:!items.length?<p className="cap-empty">没有待核对的外部操作。</p>:<ul className="cap-list">{items.map(item=><li key={item.attemptId}><div><h3>{tools.find(t=>t.name===item.toolName)?.description??item.toolName}</h3><p>{item.canResolve?'结果未确认':'仍在执行'} · {new Date(item.updatedAt).toLocaleString('zh-CN')}</p><p>调用编号：{item.attemptId}</p></div><button className="secondary-button" type="button" disabled={busy||!item.canResolve} onClick={()=>{setSelected(item);setOutcome('');setNote('');setConfirmed(false);setNotice('');}}>记录核对结果</button></li>)}</ul>}
  {selected&&<form className="cap-editor" onSubmit={e=>{e.preventDefault();void resolve();}}>
   <h3>记录核对结果</h3><p>{tools.find(t=>t.name===selected.toolName)?.description??selected.toolName}</p>
   <fieldset disabled={busy}><legend>外部服务中的实际结果</legend>
    <label className="cap-checkbox"><input type="radio" name="external-outcome" value="executed" checked={outcome==='executed'} onChange={()=>setOutcome('executed')}/>已确认执行</label>
    <label className="cap-checkbox"><input type="radio" name="external-outcome" value="not_executed" checked={outcome==='not_executed'} onChange={()=>setOutcome('not_executed')}/>已确认未执行</label>
   </fieldset>
   <label>核对依据<textarea value={note} onChange={e=>setNote(e.target.value)} disabled={busy} minLength={3} maxLength={1000} required placeholder="例如：在目标服务中查到了对应记录及时间。"/></label>
   <label className="cap-checkbox"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/>我已核对目标服务，确认上述结果</label>
   <div className="cap-actions"><button type="submit" className="primary-button" disabled={busy||!confirmed||!outcome||note.trim().length<3}>{busy?'正在记录…':'保存核对结果'}</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>setSelected(null)}>暂不处理</button></div>
  </form>}
 </section>;
}
