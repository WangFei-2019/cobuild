import React,{useEffect,useRef,useState} from 'react';
import {App as AntApp,Alert,Button,Card,Checkbox,Collapse,Empty,Form,Input,Modal,Select,Space,Spin,Tag} from 'antd';
import {CopyOutlined,RobotOutlined,ReloadOutlined} from '@ant-design/icons';
import {activeMembers,api,canManage,isDemo,shanghaiDay} from './lib.js';
import {useRecoverableDraft,DraftNotice} from './draft-store.jsx';
import './ai-assistance.css';

const MODES=[{value:'weekly',label:'有来源的周报'},{value:'actions',label:'讨论 / 纪要转行动'},{value:'check',label:'交付完整性检查'}];
const HEADINGS={completed:'本期已交接',progress:'当前推进情况',blocked:'当前阻碍',next:'建议下一步',decisions:'需要讨论与决策'};
const STATUS={evidence_found:{label:'找到文字线索 · 未核实',color:'processing'},missing:{label:'缺少材料',color:'warning'},unverifiable:{label:'目前无法验证',color:'default'}};
const lines=value=>String(value||'').split('\n').map(item=>item.trim()).filter(Boolean);
function weeklyText(output,projectId,state){return '# '+output.result.title+'\n\n'+output.result.sections.map(section=>'## '+HEADINGS[section.key]+'\n'+(section.items.map(item=>'- '+item.text+' '+item.sourceRefs.map(ref=>{const source=output.sources.find(value=>value.id===ref.sourceId),label=source?.taskCode||source?.title||'来源记录',href=sourceHref(projectId,source,state);return href?'['+label+']('+new URL(href,location.href).href+')':'（'+label+'）';}).join(' ')).join('\n')||'当前提供的资料中没有可引用记录。')).join('\n\n')+'\n\n## 未知与局限\n'+output.result.unknowns.map(item=>'- '+item).join('\n');}
function sourceHref(projectId,source,state){
  if(!source?.taskId||!state.tasks.some(task=>task.id===source.taskId))return null;
  const path=`/projects/${encodeURIComponent(projectId)}/tasks?task=${encodeURIComponent(source.taskId)}${source.discussionId?'&discussion='+encodeURIComponent(source.discussionId):''}`;
  return isDemo?`${location.pathname}${location.search}#${path}`:path;
}
function Evidence({refs=[],output,state,projectId}){
  if(!refs.length)return <span className="assistance-muted">尚无可引用材料</span>;
  return <div className="assistance-evidence">{refs.map((ref,index)=>{const source=output.sources.find(item=>item.id===ref.sourceId),href=sourceHref(projectId,source,state);return <div key={index}><div className="assistance-source-name">{href?<a href={href} target="_blank" rel="noopener noreferrer">{source?.taskCode||source?.title||ref.sourceId} ↗</a>:source?.title||ref.sourceId}<span>{source?.scope==='current'?'当前快照':source?.scope==='period'?'指定区间记录':'本次引用资料'}</span></div><blockquote>{ref.quote}</blockquote></div>;})}</div>;
}

export function AIAssistanceModal({state,projectId,onSaved,onClose,onDirty,initialMode='weekly'}){
  const {message,modal}=AntApp.useApp(),[requestForm]=Form.useForm(),[actionForm]=Form.useForm();
  const [mode,setMode]=useState(MODES.some(item=>item.value===initialMode)?initialMode:'weekly'),[output,setOutput]=useState(null),[selected,setSelected]=useState([]),[brief,setBrief]=useState('');
  const [busy,setBusy]=useState(false),[applying,setApplying]=useState(false),[error,setError]=useState(''),[touched,setTouched]=useState(false),[edited,setEdited]=useState(false);
  const [capability,setCapability]=useState(null),[capLoading,setCapLoading]=useState(true),[capError,setCapError]=useState(''),[capEpoch,setCapEpoch]=useState(0);
  const alive=useRef(true),pending=useRef(false),dirtyCallback=useRef(onDirty);dirtyCallback.current=onDirty;
  const current=state.members.find(person=>person.id===state.currentMemberId),canWrite=Boolean(current&&current.active!==false&&current.accessRole!=='viewer'&&!state.permissions?.readOnly);
  const eligibleTasks=state.tasks.filter(task=>canManage(state)||[task.ownerId,task.reviewerId].includes(state.currentMemberId));
  const options=activeMembers(state).filter(person=>person.accessRole!=='viewer').map(person=>({value:person.id,label:person.name}));
  const today=shanghaiDay(),weekStart=new Date(today+'T00:00:00Z');weekStart.setUTCDate(weekStart.getUTCDate()-6);
  const draft=useRecoverableDraft({projectId,form:'assistance',version:state.revision,canWrite,onRestore(data){
    const value={...data,output:data.result};if(!MODES.some(item=>item.value===data.mode)||!value.request||typeof value.request!=='object')throw Error('这份AI草稿格式不完整，请保留原输入后重新整理。');
    if(value.output&&(!Array.isArray(value.output.sources)||!Number.isSafeInteger(value.output.baseRevision)||value.output.mode!==data.mode||!value.output.result||value.output.result?.projectId&&value.output.result.projectId!==projectId||data.mode==='weekly'&&!Array.isArray(value.output.result.sections)||data.mode==='actions'&&!Array.isArray(value.output.result.items)||data.mode==='check'&&!Array.isArray(value.output.result.checks)))throw Error('这份草稿不属于当前项目或格式已失效。');
    setMode(data.mode);requestForm.setFieldsValue(value.request);setOutput(value.output||null);setSelected(Array.isArray(value.selected)?value.selected:[]);setBrief(typeof value.brief==='string'?value.brief:'');if(value.values)actionForm.setFieldsValue(value.values);setTouched(true);setEdited(true);setError('');
  }});
  function persist(extra={}){const value={mode,request:requestForm.getFieldsValue(true),output,selected,brief,edited,values:actionForm.getFieldsValue(true),...extra};draft.update({mode:value.mode,request:value.request,result:value.output,selected:value.selected,brief:value.brief,edited:value.edited,values:value.values,baseRevision:value.output?.baseRevision??state.revision},value.output?.baseRevision??state.revision);}
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{dirtyCallback.current?.(touched||Boolean(output));return()=>dirtyCallback.current?.(false);},[touched,Boolean(output)]);
  useEffect(()=>{let active=true;const controller=new AbortController();setCapLoading(true);setCapError('');setCapability(null);api(`/api/ai/access?projectId=${encodeURIComponent(projectId)}`,undefined,{signal:controller.signal}).then(value=>{if(typeof value.configured!=='boolean'||typeof value.canGenerate!=='boolean')throw Error('AI服务状态不完整');if(active)setCapability(value);}).catch(err=>{if(active&&err.name!=='AbortError')setCapError(err.message);}).finally(()=>{if(active)setCapLoading(false);});return()=>{active=false;controller.abort();};},[projectId,capEpoch]);
  const stale=output&&output.baseRevision!==state.revision;
  async function generate(){
    if(pending.current||!canWrite||capLoading||!capability?.configured||!capability?.canGenerate)return;
    let values;try{values=await requestForm.validateFields();}catch{return;}
    const request={projectId,mode,...(mode==='weekly'?{from:values.from,to:values.to}:mode==='actions'?{minutes:values.minutes||'',discussionIds:values.discussionIds||[]}:{taskId:values.taskId})};
    const run=async()=>{pending.current=true;setBusy(true);setError('');try{
      const result=await api('/api/ai/assistance',request);if(!alive.current)return;const text=mode==='weekly'?weeklyText(result,projectId,state):'';
      const actionValues=mode==='actions'?{items:result.result.items.map(item=>({...item,questionsText:item.questions.join('\n')}))}:{};
      setOutput(result);setBrief(text);setSelected([]);setEdited(false);setTouched(true);if(mode==='actions')actionForm.setFieldsValue(actionValues);
      persist({output:result,brief:text,selected:[],values:actionValues});
    }catch(err){if(alive.current){setError(err.message);if([402,403,429,503].includes(err.status))setCapEpoch(value=>value+1);}}finally{pending.current=false;if(alive.current)setBusy(false);}};
    if(output&&edited)modal.confirm({title:'重新生成并替换当前结果？',content:'当前编辑在新结果生成成功前会保留。可以先复制周报或保留本机草稿。',okText:'重新生成',cancelText:'保留当前编辑',onOk:run});else await run();
  }
  async function apply(){
    if(pending.current||!output||stale||!canWrite)return;const values=actionForm.getFieldsValue(true);
    const items=output.result.items.map((item,index)=>{const value=values.items?.[index]||item,owner=state.members.find(person=>person.id===value.ownerId),reviewer=state.members.find(person=>person.id===value.reviewerId);return {...item,...value,ownerId:value.ownerId||'',reviewerId:value.reviewerId||'',due:value.due||'',milestoneId:value.milestoneId||'',dependsOn:value.dependsOn||[],ownerName:owner?.name||value.ownerName||'',reviewerName:reviewer?.name||value.reviewerName||'',questions:lines(value.questionsText),questionsText:undefined};}).map(({questionsText,...item})=>item);
    const actionDraft={...output.result,items};pending.current=true;setApplying(true);setError('');
    try{const result=await api('/api/assistance/apply',{projectId,expectedRevision:output.baseRevision,draft:actionDraft,selectedIds:selected});if(!alive.current)return;draft.clear();dirtyCallback.current?.(false);onSaved?.(result.state);message.success(`已建立 ${selected.length} 项待开始任务`);onClose();}
    catch(err){if(alive.current)setError(err.message);}finally{pending.current=false;if(alive.current)setApplying(false);}
  }
  async function copy(){try{await navigator.clipboard.writeText(brief);message.success('已复制周报草稿');}catch{message.info('浏览器暂不允许复制，请从下方文本框选择内容复制。');}}
  const disabled=busy||applying;
  function changeMode(value){if(value===mode)return;const run=()=>{setMode(value);setOutput(null);setSelected([]);setBrief('');setError('');setEdited(false);setTouched(true);persist({mode:value,output:null,selected:[],brief:'',values:{}});};if(output)modal.confirm({title:'切换工具并清除当前结果？',content:'输入条件会保留，当前结果和编辑会清除。请先复制需要的内容。切换后需重新生成。',okText:'切换并清除结果',onOk:run});else run();}
  const footer=<Space wrap><Button disabled={disabled} onClick={onClose}>关闭</Button>{output?.mode==='weekly'&&<Button icon={<CopyOutlined/>} disabled={disabled} onClick={copy}>复制周报草稿</Button>}{output?.mode==='actions'&&<Button type="primary" loading={applying} disabled={busy||stale||!selected.length||!canWrite} onClick={apply}>确认创建所选 {selected.length} 项行动</Button>}</Space>;
  return <Modal open forceRender width={1000} title={<Space><RobotOutlined/>AI 协作助手</Space>} footer={footer} onCancel={disabled?undefined:onClose} closable={!disabled} mask={{closable:!disabled}} styles={{body:{maxHeight:'72vh',overflowY:'auto'}}}>
    <div className="ai-assistance">
      <DraftNotice draft={draft} label="AI助手"/>
      <Select aria-label="选择AI协作工具" value={mode} options={MODES} onChange={changeMode} disabled={disabled} style={{minWidth:250}}/>
      <div className="assistance-disclosure">只发送当前项目中本工具需要的资料与本次粘贴内容，不读取其他项目或附件二进制。AI 结果需人工核对，来源记录也可能不完整。</div>
      {capLoading?<Space><Spin size="small"/><span>正在确认你的模型服务与额度…</span></Space>:capError?<Alert type="warning" showIcon title="暂时无法确认AI服务" description={<Space wrap><span>{capError}</span><Button size="small" onClick={()=>setCapEpoch(value=>value+1)}>重试</Button></Space>}/>:!capability?.configured||!capability?.canGenerate?<Alert type="info" showIcon title="当前没有可用的AI服务" description={<><p>到个人设置配置自己的模型，或联系管理员开通平台额度。已有规则简报、手动任务与交接仍可使用。</p><a href={isDemo?`${location.pathname}${location.search}#/account/ai`:'/account/ai'} target="_blank" rel="noopener noreferrer">打开 AI 服务设置 ↗</a><Button size="small" type="link" onClick={()=>setCapEpoch(value=>value+1)}>重新检查</Button></>}/>:<div className="assistance-service"><Tag color="processing">{capability.source==='personal'?'使用你的模型服务':'使用平台服务'}</Tag>{Number.isFinite(capability.remaining)&&<span>剩余 {capability.remaining} 次</span>}<Button type="text" size="small" icon={<ReloadOutlined/>} disabled={disabled} onClick={()=>setCapEpoch(value=>value+1)}>刷新</Button></div>}
      {!canWrite&&<Alert type="warning" showIcon title="当前身份不能写入项目" description="AI协作助手仅供当前有效非只读成员使用，已有输入会保留。"/>}
      <Form form={requestForm} layout="vertical" disabled={disabled||!canWrite} initialValues={{from:weekStart.toISOString().slice(0,10),to:today,minutes:'',discussionIds:[],taskId:eligibleTasks.find(task=>task.artifacts?.length)?.id||eligibleTasks[0]?.id}} onValuesChange={()=>{setTouched(true);persist();}} style={{marginTop:16}}>
        {mode==='weekly'?<><div className="assistance-grid"><Form.Item name="from" label="区间开始（上海日期）" rules={[{required:true}]}><Input type="date"/></Form.Item><Form.Item name="to" label="区间结束（上海日期）" rules={[{required:true}]}><Input type="date"/></Form.Item></div><p className="assistance-muted">本期成果按接收时间核对。当前分工和阻碍以快照展示，未记录的工作不会当作已完成。</p></>:mode==='actions'?<><Form.Item name="discussionIds" label="明确选择用于提取的讨论"><Select mode="multiple" allowClear optionFilterProp="label" options={(state.discussions||[]).map(entry=>({value:entry.id,label:`${state.tasks.find(task=>task.id===entry.taskId)?.code||'讨论'} · ${entry.body.slice(0,70)}`}))} maxCount={40} placeholder="不选择时不会发送任何讨论"/></Form.Item><Form.Item name="minutes" label="或粘贴本次纪要" extra="未明确的姓名、日期与交付要求会保留为待确认。粘贴内容只作为资料，不作为系统指令。"><Input.TextArea rows={5} maxLength={12000} showCount placeholder="谁准备做什么、何时交给谁确认？"/></Form.Item></>:<><Form.Item name="taskId" label="检查哪项任务" rules={[{required:true}]}><Select optionFilterProp="label" showSearch options={eligibleTasks.map(task=>({value:task.id,label:`${task.code} ${task.title}`}))}/></Form.Item><p className="assistance-muted">依据交付约定、阶段验收要求、成果文字说明和文件元信息逐项核对。不读取文件二进制、不访问链接、不运行功能，也不会自动验收。</p></>}
        <Button type="primary" icon={<RobotOutlined/>} loading={busy} disabled={applying||!canWrite||capLoading||!capability?.configured||!capability?.canGenerate} onClick={generate}>{output?'重新生成草案':'生成待核对结果'}</Button>
      </Form>
      {error&&<Alert type="error" showIcon title={error} description={output?'当前结果与编辑仍保留，没有部分写入项目。':undefined}/>}
      {output&&<section className="assistance-results">
        <div className="assistance-result-title"><h3>{output.mode==='weekly'?'周报草稿':output.mode==='actions'?'候选行动 · 尚未创建':'交付完整性检查 · 不是验收结论'}</h3><Tag>项目 v{output.baseRevision}</Tag></div>
        {stale&&<Alert type="warning" showIcon title="项目在生成后已有更新" description="本结果仍基于原快照，输入和编辑已保留。行动不能改写来源版本后强行应用；请按当前项目重新生成并核对。"/>}
        {(output.disclosure?.omissions?.sources>0||output.disclosure?.omissions?.truncated>0)&&<Alert type="warning" showIcon title="本次资料有省略" description={`省略 ${output.disclosure.omissions.sources} 条来源，截断 ${output.disclosure.omissions.truncated} 条长说明。未提供部分不能据此判断。`}/>}
        <p className="assistance-muted">模型：{output.model} · {output.disclosure?.scope}。引文只证明存在这条记录，不证明记录内容或AI解释属实。</p>
        {output.mode==='weekly'?<><Input.TextArea aria-label="编辑AI周报草稿" value={brief} rows={14} disabled={disabled} onChange={event=>{setBrief(event.target.value);setEdited(true);persist({brief:event.target.value});}}/><Collapse className="assistance-proof" items={[{key:'evidence',label:'逐条核对周报来源',children:output.result.sections.map(section=><section key={section.key}><h4>{HEADINGS[section.key]}</h4>{section.items.map((item,index)=><div className="assistance-proof-item" key={index}><p>{item.text}</p><Evidence refs={item.sourceRefs} output={output} state={state} projectId={projectId}/></div>)}</section>)}]}/></>:output.mode==='actions'?<>
          <p className="assistance-muted">只创建明确勾选的候选。请核对每项分工、日期、依赖和交付要求，并清空已解决的待确认项；不会自动修改已有任务。</p>
          {output.result.questions.length>0&&<Alert type="info" showIcon title="整份资料仍有待确认事项" description={output.result.questions.map((item,index)=><div key={index}>{item}</div>)}/>}
          {!output.result.items.length?<Empty description="所选资料未提取出明确行动，可补充纪要后重试"/>:<Form form={actionForm} layout="vertical" disabled={disabled||!canWrite} onValuesChange={()=>{setEdited(true);persist();}}><Form.List name="items">{fields=>fields.map(({key,name})=>{const item=output.result.items[name];return <Card key={key} size="small" className="assistance-candidate" title={<Checkbox checked={selected.includes(item.id)} disabled={disabled||!canWrite} onChange={event=>{const next=event.target.checked?[...selected,item.id]:selected.filter(id=>id!==item.id);setSelected(next);setEdited(true);persist({selected:next});}}>候选 {name+1} · 确认后创建</Checkbox>}>
            <Form.Item name={[name,'title']} label="任务名称"><Input maxLength={180}/></Form.Item><Form.Item name={[name,'description']} label="任务说明"><Input.TextArea rows={2} maxLength={3000}/></Form.Item>
            <div className="assistance-grid"><Form.Item name={[name,'ownerId']} label={`负责人${!item.ownerId&&item.ownerName?' · 待映射：'+item.ownerName:''}`}><Select allowClear options={options} placeholder="选择当前项目人员" onChange={value=>{actionForm.setFieldValue(['items',name,'ownerId'],value||'');}}/></Form.Item><Form.Item name={[name,'reviewerId']} label={`接收人${!item.reviewerId&&item.reviewerName?' · 待映射：'+item.reviewerName:''}`}><Select allowClear options={options} placeholder="选择当前项目人员" onChange={value=>{actionForm.setFieldValue(['items',name,'reviewerId'],value||'');}}/></Form.Item><Form.Item name={[name,'due']} label="明确截止日期"><Input type="date"/></Form.Item><Form.Item name={[name,'milestoneId']} label="所属阶段（可空）"><Select allowClear options={(state.milestones||[]).map(phase=>({value:phase.id,label:phase.title}))} onChange={value=>actionForm.setFieldValue(['items',name,'milestoneId'],value||'')}/></Form.Item></div>
            <Form.Item name={[name,'deliverable']} label="交付与验收要求"><Input.TextArea rows={2} maxLength={1000}/></Form.Item><Form.Item name={[name,'dependsOn']} label="依赖的候选行动"><Select mode="multiple" options={output.result.items.filter(other=>other.id!==item.id).map(other=>({value:other.id,label:other.title}))}/></Form.Item><Form.Item name={[name,'questionsText']} label="逐项待确认（解决后删除对应行）"><Input.TextArea rows={2} maxLength={20000}/></Form.Item><Evidence refs={item.sourceRefs} output={output} state={state} projectId={projectId}/>
          </Card>;})}</Form.List></Form>}
        </>:<><Alert type="info" showIcon title="AI不能代替接收人的验收" description={output.result.summary}/>{output.result.checks.map((item,index)=>{const criterion=output.criteria?.find(value=>value.id===item.criterionId);return <Card key={item.criterionId} size="small" className="assistance-check" title={<span>{index+1}. {criterion?.scope==='milestone'?'阶段要求':'交付要求'}</span>} extra={<Tag color={STATUS[item.status]?.color}>{STATUS[item.status]?.label||'待核对'}</Tag>}><p className="assistance-criterion">{criterion?.text}</p><p>{item.explanation}</p><Evidence refs={item.sourceRefs} output={output} state={state} projectId={projectId}/></Card>;})}<Alert type="warning" showIcon title="检查局限" description={<>{output.result.limitations.map((item,index)=><div key={index}>{item}</div>)}<div>实际内容、功能运行与材料真实性仍需人工检查。本操作没有更改任务或阶段的验收状态。</div></>}/></>}
      </section>}
    </div>
  </Modal>;
}
