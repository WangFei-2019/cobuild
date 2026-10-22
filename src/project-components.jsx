import React,{useEffect,useRef,useState} from 'react';
import {App as AntApp,Alert,Button,Checkbox,Collapse,Descriptions,Divider,Form,Input,Modal,Select,Space,Tabs,Tag,Upload,Typography} from 'antd';
import {CheckOutlined,ClockCircleOutlined,DeleteOutlined,FileOutlined,MessageOutlined,PlusOutlined,UploadOutlined} from '@ant-design/icons';
import {STATUS,PRIORITY,activeMembers,api,isDemo,dateLabel,safeURL,canManage} from './lib.js';
import {ActivityList,Artifact,Person,StatusTag} from './shared.jsx';
import ColorField,{PROJECT_COLORS,colorRules} from './color-field.jsx';
import TaskDiscussion from './task-discussion.jsx';
import TaskLifecycle from './task-lifecycle.jsx';
import {DraftNotice,useRecoverableDraft} from './draft-store.jsx';
const {Text}=Typography;const {TextArea}=Input;
export function NewProjectModal({ownerName,onCreate,onClose,onDirty,onTemplate}) {
  const [form] = Form.useForm(),[saving,setSaving] = useState(false),[starter,setStarter] = useState('product'),pending=useRef(false);
  const addPartners=Form.useWatch('inviteAfterCreate',form)!==false;
  const starters = {product:{name:'产品与开发',note:'从首个可体验版本开始',goal:'例如：在月底前交付可供 5 位用户试用的原型，完成主要流程并由产品负责人验收。',description:'产品面向谁？准备解决什么具体问题？'},research:{name:'研究与内容',note:'把产出与检查标准说清楚',goal:'例如：两周内完成一份有来源可追溯的专题报告，由编辑检查结构、证据和结论。',description:'这次要回答什么问题？成果给谁使用？'},event:{name:'活动与协作',note:'让准备、执行和交接接上',goal:'例如：周六完成一次 20 人交流活动，交付执行清单、现场记录和参加者反馈。',description:'活动服务谁？为什么值得一起组织？'}};
  async function submit(values) {if(pending.current)return;pending.current=true;setSaving(true);try{const ok=await onCreate({...values,members:[]});if(ok)onClose();}finally{pending.current=false;setSaving(false);}}
  return <Modal open title="创建项目" width={700} onCancel={saving?undefined:onClose} keyboard={!saving} onOk={()=>form.submit()} confirmLoading={saving} okText={addPartners?(isDemo?'创建并添加伙伴':'创建并邀请伙伴'):'创建项目'} cancelText="取消" mask={{closable:!saving}} closable={!saving} cancelButtonProps={{disabled:saving}} styles={{body:{maxHeight:'72vh',overflowY:'auto',paddingRight:4}}}>
    <p className="modal-intro">先写清共同目标，创建后再安排伙伴与分工。</p>
    {onTemplate&&<Button type="link" disabled={saving} onClick={onTemplate} style={{paddingInline:0,marginBottom:15}}>从我的模板创建</Button>}
    {!isDemo&&<p className="modal-intro">访问范围：项目成员与工作区管理员。其他账号通过邀请加入。</p>}
    <div className="prj-starter-options" aria-label="项目起步方向">{Object.entries(starters).map(([key,item])=><button key={key} type="button" disabled={saving} className={starter===key?'active':''} aria-pressed={starter===key} onClick={()=>setStarter(key)}><strong>{item.name}</strong><small>{item.note}</small></button>)}</div>
    <Form form={form} layout="vertical" disabled={saving} onFinish={submit} onValuesChange={()=>onDirty?.(true)} initialValues={{name:'',description:'',goal:'',deadline:'',ownerRole:'项目发起人',color:PROJECT_COLORS[0],inviteAfterCreate:true}} className="modal-form">
      <Form.Item label="项目名称" name="name" rules={[{required:true,whitespace:true,message:'请填写项目名称'}]}><Input placeholder="例如：周末一起做个小工具" maxLength={100} autoFocus/></Form.Item>
      <Form.Item label="项目标识色" name="color" rules={colorRules} extra="用于项目导航与来源标记。可选择预设，也可自选或填写 HEX 色值。"><ColorField disabled={saving}/></Form.Item>
      <Form.Item label="项目简介" name="description"><TextArea rows={2} maxLength={500} placeholder={starters[starter].description}/></Form.Item>
      <Form.Item label="共同目标" name="goal"><TextArea rows={2} maxLength={1500} placeholder={starters[starter].goal}/></Form.Item>
      <div className="project-create-details"><Form.Item label="截止日期" name="deadline"><Input type="date"/></Form.Item><Form.Item label="你的负责方向" name="ownerRole"><Input maxLength={80} placeholder="例如：产品设计与项目推进"/></Form.Item></div>
      <div className="project-create-partners"><Form.Item name="inviteAfterCreate" valuePropName="checked"><Checkbox>{isDemo?'创建后进入成员页添加伙伴':'创建后进入成员页邀请伙伴'}</Checkbox></Form.Item><p>{ownerName}将作为项目发起人。{isDemo?'可从人员目录选择已有档案，或新建档案记录分工。当前演示不能向真实账号发送邀请。':'成员页可以选择已有人员，或生成邀请链接，由伙伴登录或注册后确认加入。新建人员档案只记录分工，不代表本人已获得访问权限。'}</p></div>
    </Form>
  </Modal>;
}
export function EditorModal({editor,state,actorId,action,onClose}) {
  const {modal}=AntApp.useApp();
  const [form] = Form.useForm();
  const [saving,setSaving] = useState(false);
  const kind = editor.kind;
  const [record,setRecord] = useState(editor.record);
  const latestRecord=record&&state.tasks.find(task=>task.id===record.id);
  const staleTask=kind==='task'&&Boolean(record)&&(!latestRecord||latestRecord.updatedAt!==record.updatedAt);
  const title = {task:record ? '编辑任务' : '新建任务',project:'项目设置',changes:'退回修改',block:'记录受阻原因'}[kind];
  const initialValues = kind === 'task' ? {title:record?.title || '',description:record?.description || '',ownerId:record?.ownerId || actorId,reviewerId:record?.reviewerId || activeMembers(state).find(member => member.id !== actorId&&member.accessRole!=='viewer')?.id || actorId,due:record?.due || state.project.deadline,priority:record?.priority || 'medium',deliverable:record?.deliverable || '',dependsOn:record?.dependsOn || [],milestoneId:record?.milestoneId || ''} : kind === 'project' ? {...state.project} : kind === 'block' ? {blocker:record?.blocker || ''} : {reason:''};
  const options = activeMembers(state).filter(person=>person.accessRole!=='viewer').map(person => ({value:person.id,label:`${person.name} · ${person.role}`}));
  const editDraft=useRecoverableDraft({projectId:kind==='task'?state.project.id:null,taskId:record?.id||'new',form:record?'task-edit':'task-new',version:record?.updatedAt??state.revision,canWrite:kind==='task'&&(!record||record.status!=='canceled')&&(canManage(state)||!state.permissions?.readOnly&&(record?latestRecord?.ownerId===actorId:state.permissions?.createTask)),onRestore:(data,saved)=>{form.setFieldsValue(data);if(record)setRecord(current=>({...current,updatedAt:saved.baseVersion}));}});
  async function submit(values) {
    if(staleTask)return;
    setSaving(true);
    if (kind === 'task') values = {...values,milestoneId:values.milestoneId || ''};
    let success = false;
    if (kind === 'task') success = await action(record ? 'updateTask' : 'createTask',record ? {taskId:record.id,taskUpdatedAt:record.updatedAt,patch:values} : values,record ? '任务约定已更新' : '任务已创建');
    if (kind === 'project') success = await action('updateProject',{expectedRevision:editor.revision,patch:{name:values.name,goal:values.goal,description:values.description || '',deadline:values.deadline,color:values.color}},'项目设置已保存');
    if (kind === 'changes') success = await action('requestChanges',{taskId:record.id,taskUpdatedAt:record.updatedAt,reason:values.reason},'已退回修改，意见已记录');
    if (kind === 'block') success = await action('setStatus',{taskId:record.id,status:'blocked',blocker:values.blocker},'受阻原因已保存');
    setSaving(false);if (success) {editDraft.clear();onClose();}
  }
  return <Modal title={title} open onCancel={onClose} onOk={() => form.submit()} confirmLoading={saving} okButtonProps={{disabled:staleTask}} okText={kind === 'task' && !record ? '创建任务' : kind === 'changes' ? '退回并记录' : '保存'} cancelText="取消" width={kind === 'task' ? 640 : 560} mask={{closable:!saving}} closable={!saving} cancelButtonProps={{disabled:saving}} destroyOnHidden><DraftNotice draft={editDraft} label="任务编辑"/>{staleTask&&<Alert type="warning" showIcon style={{marginBottom:20}} title={latestRecord?'任务已有新更新，当前输入已保留':'这项任务已移除，当前输入仍保留'} description={latestRecord?<><p>保存已暂停，避免覆盖其他人的修改。可先查看最新约定，再决定是否替换当前输入。</p><details className="task-latest-preview"><summary>查看最新任务约定（保留当前输入）</summary><Descriptions column={1} size="small" items={[
{key:'title',label:'任务',children:latestRecord.title},
{key:'description',label:'说明',children:latestRecord.description||'未设置'},
{key:'owner',label:'负责人',children:state.members.find(member=>member.id===latestRecord.ownerId)?.name||'未指定'},
{key:'reviewer',label:'接收人',children:state.members.find(member=>member.id===latestRecord.reviewerId)?.name||'未指定'},
{key:'due',label:'截止日期',children:dateLabel(latestRecord.due,true)},
{key:'deliverable',label:'约定交付',children:latestRecord.deliverable||'未设置'},
{key:'milestone',label:'里程碑',children:state.milestones?.find(item=>item.id===latestRecord.milestoneId)?.title||'未关联'},
{key:'depends',label:'前置依赖',children:latestRecord.dependsOn?.map(id=>state.tasks.find(item=>item.id===id)?.title||id).join('、')||'无'}
]}/></details><Button size="small" style={{marginTop:12}} onClick={()=>modal.confirm({title:'载入最新任务约定？',content:'这会替换当前表单输入。你可以先把自己的编辑复制保留，再继续。',okText:'载入最新约定',cancelText:'保留当前输入',onOk:()=>{editDraft.clear();setRecord(structuredClone(latestRecord));form.setFieldsValue({title:latestRecord.title,description:latestRecord.description||'',ownerId:latestRecord.ownerId,reviewerId:latestRecord.reviewerId,due:latestRecord.due||'',priority:latestRecord.priority||'medium',deliverable:latestRecord.deliverable||'',dependsOn:latestRecord.dependsOn||[],milestoneId:latestRecord.milestoneId||''});}})}>载入最新任务并重新编辑</Button></>:<p>请关闭本窗口并返回任务列表核对。</p>}/>}<Form form={form} layout="vertical" initialValues={initialValues} onValuesChange={(_,values)=>{if(kind==='task')editDraft.update(values,record?.updatedAt??state.revision);}} onFinish={submit} className="modal-form">
    {kind === 'task' && <><div className="modal-intro">约定负责人、接收人和具体成果，让每个人知道下一步。</div><Form.Item label="任务名称" name="title" rules={[{required:true,whitespace:true,message:'请填写任务名称'}]}><Input maxLength={180} placeholder="例如：完成首版首页原型" autoFocus/></Form.Item><Form.Item label="任务说明" name="description"><TextArea rows={3} maxLength={3000} placeholder="说明任务范围、背景和需要注意的细节"/></Form.Item><div className="form-grid"><Form.Item label="负责人" name="ownerId" rules={[{required:true}]}><Select options={options}/></Form.Item><Form.Item label="成果接收人" name="reviewerId" rules={[{required:true}]}><Select options={options}/></Form.Item><Form.Item label="截止日期" name="due" rules={[{required:true,message:'请选择截止日期'}]}><Input type="date"/></Form.Item><Form.Item label="优先级" name="priority"><Select options={Object.entries(PRIORITY).map(([value,label]) => ({value,label}))}/></Form.Item></div><Form.Item label="约定交付物" name="deliverable" rules={[{required:true,whitespace:true,message:'请说明要交付什么'}]} extra="接收人依据这项约定检查成果。"><Input maxLength={1000} placeholder="例如：原型链接，包含首页与结果页"/></Form.Item><Form.Item label="所属里程碑" name="milestoneId"><Select allowClear placeholder="可选" options={(state.milestones || []).map(milestone => ({value:milestone.id,label:milestone.title}))}/></Form.Item><Form.Item label="前置依赖" name="dependsOn"><Select mode="multiple" placeholder="可选，需要先完成哪些任务" options={state.tasks.filter(item => item.id !== record?.id&&item.status!=='canceled').map(item => ({value:item.id,label:`${item.code} · ${item.title}`}))}/></Form.Item></>}
    {kind === 'project' && <><Form.Item label="项目标识色" name="color" rules={colorRules}><ColorField/></Form.Item><Form.Item label="项目名称" name="name" rules={[{required:true,whitespace:true}]}><Input maxLength={100}/></Form.Item><Form.Item label="共同目标" name="goal"><TextArea rows={3} maxLength={1500}/></Form.Item><Form.Item label="项目说明" name="description"><TextArea rows={2} maxLength={500}/></Form.Item><Form.Item label="截止日期" name="deadline"><Input type="date"/></Form.Item></>}
    {kind === 'changes' && <><p className="modal-intro">{record.title}<br/>说明需要补充或调整的内容，让负责人清楚下一步。</p><Form.Item label="修改意见" name="reason" rules={[{required:true,whitespace:true,message:'请填写修改意见'}]}><TextArea rows={4} maxLength={2000} placeholder="例如：缺少移动端结果页，请补充后重新提交。" autoFocus/></Form.Item></>}
    {kind === 'block' && <Form.Item label="哪里卡住了？需要什么帮助？" name="blocker" rules={[{required:true,whitespace:true,message:'请说明受阻原因'}]}><TextArea rows={4} maxLength={1000} autoFocus/></Form.Item>}
  </Form></Modal>;
}

export async function encodeFile(file) {
  if (file.size > (isDemo?500*1024:5*1024*1024)) throw new Error(isDemo?'演示单个文件最多 500 KB，请选择较小文件或提供链接。':'文件超过 5 MiB，请选择较小的文件或提供链接。');
  const base64 = await new Promise((resolve,reject) => {const reader = new FileReader();reader.onload = () => resolve(String(reader.result).split(',')[1]);reader.onerror = () => reject(new Error('读取文件失败，请重新选择。'));reader.readAsDataURL(file);});
  return {name:file.name,type:file.type || 'application/octet-stream',base64};
}

export function TaskDetail(props){
 const [activeTab,setActiveTab]=useState(props.discussionId?'discussion':'details'),parts=useRef({work:false,discussion:false}),callback=useRef(props.onDirty);callback.current=props.onDirty;
 function report(part,value){parts.current[part]=value;callback.current?.(Object.values(parts.current).some(Boolean));}
 useEffect(()=>()=>callback.current?.(false),[]);
 useEffect(()=>{if(props.discussionId)setActiveTab('discussion');},[props.discussionId]);
 const count=(props.state.discussions||[]).filter(item=>item.taskId===props.item.id).length;
 return <><div className="drawer-intro"><div className="drawer-task-code">{props.item.code}</div><h2 className="drawer-task-title">{props.item.title}</h2><Space size={8}><StatusTag value={props.item.status}/>{props.item.priority==='high'&&<Tag color="orange">高优先级</Tag>}</Space></div><Tabs className="task-detail-tabs" activeKey={activeTab} onChange={setActiveTab} destroyOnHidden={false} items={[{key:'details',label:'任务与交接',children:<TaskContent {...props} onDirty={value=>report('work',value)}/>},{key:'discussion',label:`讨论${count?` · ${count}`:''}`,children:<TaskDiscussion focusId={props.discussionId} task={props.item} state={props.state} action={props.action} onDirty={value=>report('discussion',value)}/>} ]}/></>;
}
function TaskContent({item,state,actorId,projectId,action,onEdit,onChanges,onBlock,onOpen,onDirty}) {
  const {message} = AntApp.useApp();
  const [progress,setProgress] = useState('');
  const [analysis,setAnalysis] = useState(null);
  const [analyzing,setAnalyzing] = useState(false);
  const [savingProgress,setSavingProgress] = useState(false);
  const [savingArtifact,setSavingArtifact] = useState(false);
  const [artifactBase,setArtifactBase] = useState(null);
  const staleArtifact = Boolean(artifactBase && artifactBase.updatedAt !== item.updatedAt);
  const [files,setFiles] = useState([]);
  const [artifactForm] = Form.useForm();
  const progressRef = useRef('');
  const dirtyParts = useRef({progress:false,artifact:false});
  const editable = item.status!=='canceled'&&(canManage(state) || !state.permissions?.readOnly && actorId === item.ownerId);
  const receivable = !state.permissions?.readOnly && actorId === item.reviewerId && item.status === 'review' && item.artifacts.length > 0;
  const taskName = id => state.tasks.find(candidate => candidate.id === id);
  const progressDraft=useRecoverableDraft({projectId,taskId:item.id,form:'progress',version:item.updatedAt,canWrite:editable,onRestore:data=>{setProgress(data.text||'');progressRef.current=data.text||'';setAnalysis(null);dirty('progress',Boolean(data.text?.trim()));}});
  const artifactDraft=useRecoverableDraft({projectId,taskId:item.id,form:'artifact',version:item.updatedAt,canWrite:editable,onRestore:(data,saved)=>{artifactForm.setFieldsValue({name:data.name||'',url:data.url||'',note:data.note||''});setFiles([]);dirty('artifact',true);setArtifactBase({...structuredClone(item),updatedAt:saved.baseVersion});setAnalysis(null);}});
  function dirty(part,value) {if(part==='artifact'){if(value&&!dirtyParts.current.artifact)setArtifactBase(structuredClone(item));else if(!value)setArtifactBase(null);}dirtyParts.current[part] = value;onDirty(Object.values(dirtyParts.current).some(Boolean));}
  useEffect(() => {if (analysis?.taskUpdatedAt && analysis.taskUpdatedAt !== item.updatedAt) setAnalysis(null);},[item.updatedAt,analysis?.taskUpdatedAt]);
  useEffect(() => () => onDirty(false),[]);
  async function analyze() {
    const text = progress.trim();
    if (!text) return message.warning('请先填写一点实际进展。');
    setAnalyzing(true);
    try {
      const result = await api('/api/analyze',{text,taskId:item.id,projectId});
      if (progressRef.current.trim() !== text) return message.info('内容已变化，请重新整理最新进展。');
      setAnalysis({...result.analysis,sourceText:text});
    } catch (error) {message.error(error.message);} finally {setAnalyzing(false);}
  }
  async function saveProgress(confirmed) {
    const text = progress.trim();
    if (!text) return message.warning('请先填写进展。');
    if (confirmed && (!analysis || analysis.sourceText !== text || analysis.taskUpdatedAt !== item.updatedAt)) return message.warning('任务或内容已更新，请重新整理。');
    const payload = {taskId:item.id,text};
    if (confirmed) {if (analysis.status) payload.status = analysis.status;if (analysis.blocker) payload.blocker = analysis.blocker;payload.taskUpdatedAt = analysis.taskUpdatedAt;}
    setSavingProgress(true);
    const ok = await action('addUpdate',payload,confirmed ? '进展与已确认的建议已保存' : '原文已保存，任务状态未自动改变');
    setSavingProgress(false);
    if (ok) {if (progressRef.current.trim() === text) {setProgress('');progressRef.current = '';dirty('progress',false);progressDraft.clear();}setAnalysis(null);}
  }
  async function submitArtifact(values) {
    if(staleArtifact) return message.warning('任务约定有更新，请先核对最新约定，当前成果草稿仍保留。');
    if(!artifactBase) return message.warning('请先填写成果内容，并核对当前交付约定。');
    const file = files[0]?.originFileObj || files[0];
    if (!values.url?.trim() && !values.note?.trim() && !file) return message.warning('请提供文件、链接或文字说明中的至少一项。');
    const payload = {taskId:item.id,taskUpdatedAt:artifactBase.updatedAt,name:values.name.trim(),url:values.url?.trim() || '',note:values.note?.trim() || ''};
    if (payload.url && !safeURL(payload.url)) return message.warning('请提供有效的 http 或 https 成果链接。');
    setSavingArtifact(true);
    try {
      if (file) payload.file = await encodeFile(file);
      const ok = await action('submitArtifact',payload,'成果已提交，等待接收人确认');
      if (ok) {artifactForm.resetFields();setFiles([]);dirty('artifact',false);setAnalysis(null);artifactDraft.clear();}
    } catch (error) {message.error(error.message);} finally {setSavingArtifact(false);}
  }
  const statusOptions = Object.entries(STATUS).filter(([value])=>value!=='canceled').map(([value,label]) => ({value,label:value === 'done' ? '已完成（接收后）' : label,disabled:value === 'done' || value === 'review' && (!item.artifacts.length || item.needsResubmission)}));
  return <><p className="drawer-description">{item.description}</p><Descriptions className="task-facts" column={1} size="small" items={[
    {key:'owner',label:'负责人',children:<Person id={item.ownerId} members={state.members}/>},
    {key:'reviewer',label:'成果接收人',children:<Person id={item.reviewerId} members={state.members}/>},
    {key:'due',label:'截止日期',children:dateLabel(item.due,true)},
    {key:'status',label:'更新状态',children:editable ? <Select aria-label="修改任务状态" value={item.status} options={statusOptions} style={{width:170}} onChange={value => value === 'blocked' ? onBlock(item) : action('setStatus',{taskId:item.id,status:value},`状态已更新为${STATUS[value]}`)}/> : <StatusTag value={item.status}/>},
    {key:'deliverable',label:'约定交付',children:item.deliverable || '尚未约定'},
    {key:'depends',label:'前置依赖',children:item.dependsOn?.length ? <div className="dependency-links">{item.dependsOn.map(id => taskName(id) && <Button type="link" key={id} onClick={() => onOpen(id)}>{taskName(id).code} · {taskName(id).title}（{STATUS[taskName(id).status]}）</Button>)}</div> : <Text type="secondary">无前置依赖</Text>}
  ]}/>{item.status === 'blocked' && <Alert type="warning" showIcon title="当前受阻" description={item.blocker}/>} {item.needsResubmission && <Alert type="warning" showIcon title="交付约定已变化" description="请按新约定重新提交成果，旧成果仍保留在记录中。"/>}

  <TaskLifecycle task={item} state={state} action={action} onDirty={value=>dirty('lifecycle',value)}/>
  {item.status === 'done' && <Alert className="review-alert" type="success" showIcon title="成果已确认接收" description="任务已完成，交付成果与历史记录保留。"/>}
  {(editable || Boolean(progress.trim())) && <section className="detail-section"><h3 className="detail-section-title"><MessageOutlined/>更新进展</h3><div className="detail-section-description">写下实际进展。可直接保存，或先用本地规则整理建议。</div>{!editable && <div className="permission-hint">当前账号已不再具有更新权限。你输入的原文仍保留在下方，可以选中并复制后与项目管理员确认分工。</div>}<DraftNotice draft={progressDraft} label="进展"/><TextArea aria-label="填写任务进展" value={progress} onChange={event => {const value = event.target.value;setProgress(value);progressRef.current = value;setAnalysis(null);dirty('progress',Boolean(value.trim()));if(value.trim())progressDraft.update({text:value});else progressDraft.clear();}} rows={3} maxLength={6000} readOnly={!editable} disabled={savingProgress} placeholder="例如：接口已完成，正在等待前端联调，还缺一份测试数据。"/><div className="detail-actions"><Button onClick={analyze} loading={analyzing} disabled={!editable || !progress.trim()}>整理进展</Button><Button type="primary" onClick={() => saveProgress(false)} loading={savingProgress} disabled={!editable || !progress.trim()}>保存原文</Button></div>{analysis && <Alert className="analysis-preview" type="info" showIcon title="本地规则预览" description={<><div className="analysis-text">{analysis.summary || analysis.sourceText}</div><div className="analysis-status">{analysis.status ? '建议状态' : '保留当前状态'}<StatusTag value={analysis.status || item.status}/></div>{analysis.blocker && <p className="analysis-text">受阻原因：{analysis.blocker}</p>}{analysis.missing?.length > 0 && <ul>{analysis.missing.map((value,index) => <li key={index}>{value}</li>)}</ul>}{analysis.affectedTaskIds?.length > 0 && <p className="analysis-text">可能受影响：{analysis.affectedTaskIds.map(id => taskName(id)?.code).filter(Boolean).join('、')}。请与相关成员核实。</p>}{analysis.rationale?.length > 0 && <ul>{analysis.rationale.map((value,index) => <li key={index}>{value}</li>)}</ul>}<div className="detail-section-description">当前使用关键词规则，未接入大模型。确认后只更新本任务，不会自动修改其他任务。</div><Space><Button type="primary" size="small" loading={savingProgress} onClick={() => saveProgress(true)}>确认并记录</Button><Button size="small" onClick={() => setAnalysis(null)}>放弃建议</Button></Space></>}/>}</section>}
  <section className="detail-section"><h3 className="detail-section-title"><FileOutlined/>成果与交接</h3><div className="detail-section-description">提交文件、链接或文字成果后进入待交接，由接收人确认完成。</div><div className="prj-checklist"><strong>这次交接检查什么</strong><p>{item.deliverable || '请先约定要交付的成果'}</p><p>接收人：{state.members.find(person=>person.id===item.reviewerId)?.name || '待指定'} · 先检查下方最新提交及说明，再确认或退回。</p></div><DraftNotice draft={artifactDraft} label="成果" files/><div className="artifact-list">{item.artifacts[0]&&<><div className="detail-record-label">最新提交</div><Artifact key={item.artifacts[0].id} artifact={item.artifacts[0]}/></>}</div>{item.artifacts.length>1&&<Collapse className="detail-records" size="small" items={[{key:'artifacts',label:`历史提交 · ${item.artifacts.length-1} 条`,children:<div className="artifact-list">{item.artifacts.slice(1).map(artifact=><Artifact key={artifact.id} artifact={artifact}/>)}</div>}]} />}{item.status === 'review' && <Alert className="review-alert" type="info" showIcon title={`等待${state.members.find(person => person.id === item.reviewerId)?.name || '接收人'}接收`} description={<><div>检查成果是否满足约定，再确认接收或退回修改。</div>{receivable ? <Space style={{marginTop:12}}><Button type="primary" icon={<CheckOutlined/>} onClick={() => action('accept',{taskId:item.id,taskUpdatedAt:item.updatedAt},'已确认接收，任务完成')}>确认接收</Button><Button onClick={() => onChanges(item)}>退回修改</Button></Space> : <div className="permission-hint">只有指定接收人可以处理交接。</div>}</>}/>}{staleArtifact&&<Alert className="prj-version-alert" type="warning" showIcon title="填写成果期间，任务约定有更新" description={<><p>当前输入和已选文件都已保留。请按下面的最新约定检查草稿，再继续提交。</p><div className="prj-contract-review"><strong>最新交付约定</strong><div>{item.deliverable || '尚未填写'}</div><div>负责人：{state.members.find(person=>person.id===item.ownerId)?.name || '待指定'}；接收人：{state.members.find(person=>person.id===item.reviewerId)?.name || '待指定'}；截止：{dateLabel(item.due,true)}</div></div>{editable?<Button size="small" onClick={()=>setArtifactBase(structuredClone(item))}>已核对新约定，继续编辑这份草稿</Button>:<p>当前账号已不再具有提交权限。请保留文字草稿，并与项目管理员确认后续分工。</p>}</>}/>} {(editable || artifactBase) && <Form form={artifactForm} layout="vertical" className="artifact-form" onFinish={submitArtifact} disabled={!editable || savingArtifact} onValuesChange={(_,all) => {const changed=Boolean(all.name?.trim()||all.url?.trim()||all.note?.trim()||files.length);dirty('artifact',changed);if(changed)artifactDraft.update({...all,fileNames:files.map(file=>file.name)},artifactBase?.updatedAt||item.updatedAt);else artifactDraft.clear();}}><Form.Item name="name" label="成果名称" rules={[{required:true,whitespace:true,message:'请填写成果名称'}]}><Input maxLength={200} placeholder="例如：首页原型 v2"/></Form.Item><Form.Item name="url" label="成果链接" rules={[{validator:(_,value) => !value || /^https?:\/\//i.test(value) && safeURL(value) ? Promise.resolve() : Promise.reject(new Error('请输入有效的 http 或 https 地址'))}]}><Input placeholder="https://…（可选）" maxLength={2000}/></Form.Item><Form.Item name="note" label="成果说明"><TextArea rows={3} maxLength={6000} placeholder="可直接填写文字成果，也可补充使用方法和检查要点。"/></Form.Item><Form.Item label={isDemo?'浏览器文件':'本机文件'} extra={isDemo?'演示单个文件最多 500 KB、累计 1 MB，保存在当前浏览器。':'单个文件不超过 5 MiB，上传后随项目保存在工作区服务器。'}><Upload fileList={files} maxCount={1} beforeUpload={file => {if (file.size > (isDemo?500*1024:5*1024*1024)) {message.error(isDemo?'演示单个文件最多 500 KB，请重新选择。':'文件超过 5 MiB，请重新选择。');return Upload.LIST_IGNORE;}return false;}} onChange={({fileList}) => {setFiles(fileList);if (fileList.length && !artifactForm.getFieldValue('name')) artifactForm.setFieldValue('name',fileList[0].name);const all = artifactForm.getFieldsValue();dirty('artifact',Boolean(fileList.length || all.name?.trim() || all.url?.trim() || all.note?.trim()));artifactDraft.update({...all,fileNames:fileList.map(file=>file.name)},artifactBase?.updatedAt||item.updatedAt);}}><Button icon={<UploadOutlined/>}>选择文件</Button></Upload></Form.Item><Button type="primary" htmlType="submit" icon={<UploadOutlined/>} loading={savingArtifact} disabled={staleArtifact || !editable}>提交并发起交接</Button></Form>}</section>
  <section className="detail-section detail-history"><Collapse className="detail-records" size="small" items={[{key:'activity',label:<span><ClockCircleOutlined/> 任务记录 · {state.activities.filter(record=>record.taskId===item.id).length} 条</span>,children:<ActivityList activities={state.activities.filter(record=>record.taskId===item.id)} state={state} onOpen={onOpen} detail/>}]} /></section></>;
}

