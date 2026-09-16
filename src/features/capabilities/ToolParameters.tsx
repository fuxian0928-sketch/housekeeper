type Parameter = { type?: string; description?: string; enum?: unknown[] };
const labels: Record<string,string> = {projectId:'项目标识；可通过执行范围选择',documentId:'文档标识',taskId:'任务标识',query:'要检索的内容',limit:'最多返回的条数',title:'任务或文档标题',description:'详细说明',content:'正文内容',name:'名称',url:'来源链接',status:'状态',priority:'优先级',startAt:'开始日期',dueAt:'截止日期',tasks:'需要创建的任务列表'};

function parseParameters(value: string): { properties?: Record<string,Parameter>; required?: string[] } {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (!Object.keys(parsed).length) return {properties:{}};
      return parsed;
    }
  } catch { /* Built-in tools use compact TypeScript signatures. */ }
  const body = value.trim().replace(/^\{/, '').replace(/\}$/, '');
  const parts: string[] = []; let start = 0, depth = 0;
  for (let i=0;i<body.length;i++) {
    if ('{[('.includes(body[i])) depth++;
    if ('}])'.includes(body[i])) depth--;
    if (body[i]===',' && depth===0) {parts.push(body.slice(start,i));start=i+1;}
  }
  parts.push(body.slice(start));
  const properties: Record<string,Parameter> = {}, required: string[] = [];
  for (const part of parts.filter(p=>p.trim())) {
    const match=part.trim().match(/^(\w+)(\?)?(?:\s*:\s*([\s\S]+))?$/);
    if (!match) return {};
    properties[match[1]]={type:match[3],description:labels[match[1]] ?? match[3] ?? '按完整参数定义填写'};
    if (!match[2]) required.push(match[1]);
  }
  return {properties,required};
}

export function ToolParameters({ value }: { value: string }) {
  const schema = parseParameters(value);
  if (!schema || !schema.properties) return <pre>{value}</pre>;
  const entries = Object.entries(schema.properties);
  return <div className="cap-parameters">
    {entries.length ? <dl>{entries.map(([name, field]) => <div key={name}>
      <dt><code>{name}</code><span className="cap-meta">{Array.isArray(schema.required)&&schema.required.includes(name) ? '必填' : '选填'}</span></dt>
      <dd>{typeof field?.description==='string' ? field.description : ({string:'文本',number:'数值',integer:'整数',boolean:'是 / 否',array:'列表',object:'对象'} as Record<string,string>)[field?.type ?? ''] || '按工具要求填写'}{Array.isArray(field?.enum) && <small>可选值：{field.enum.map(String).join('、')}</small>}</dd>
    </div>)}</dl> : <p>此工具不需要参数。</p>}
    <details><summary>完整参数定义</summary><pre>{value}</pre></details>
  </div>;
}
