import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Form,Modal,Select,Space,Table,Tag} from 'antd';
import {api,isDemo,useResource} from './lib.js';
import {ResourceState} from './pages.jsx';
import {StatusTag} from './shared.jsx';
import {useFormGuard} from './form-guard.js';
import './member-lifecycle.css';

const ROLES=[{value:'admin',label:'项目管理员'},{value:'member',label:'项目成员'},{value:'viewer',label:'只读成员'}];
const TITLES={setAccessRole:'调整项目权限',transferAdmin:'转交项目管理权',removeMember:'移出项目成员',leaveProject:'退出这个项目'};
export default function MemberLifecycleModal({state,member,mode,onClose,onSaved,onBeforeRevoke}){
 const resource=useResource(`/api/members/impact?projectId=${encodeURIComponent(state.project.id)}&memberId=${encodeURIComponent(member.id)}`),[form]=Form.useForm(),[pending,setPending]=useState(false),[error,setError]=useState(null),[conflict,setConflict]=useState(false);
 const busy=useRef(false),alive=useRef(true),dirty=useRef(false);useFormGuard(dirty,'成员调整表单');
 useEffect(()=>()=>{alive.current=false;},[]);
 const impact=resource.value,role=Form.useWatch('accessRole',form),permission=impact?.permissions?.[mode]===true;
 useEffect(()=>{if(impact&&form.getFieldValue('accessRole')===undefined)form.setFieldValue('accessRole',impact.member.accessRole||'member');},[impact]);
 const departing=['removeMember','leaveProject'].includes(mode),downgrade=mode==='setAccessRole'&&role==='viewer',needsReplacement=Boolean((departing||downgrade)&&impact?.responsibilities?.tasks?.length),lastAdmin=Boolean(impact?.lastAdmin&&(departing||mode==='setAccessRole'&&role!=='admin')),stale=Boolean(impact&&state.revision>impact.revision);
 const replacements=(impact?.replacements||[]).filter(item=>mode!=='transferAdmin'||item.eligibleForAdmin);
 function close(){if(busy.current)return;if(dirty.current&&!window.confirm('放弃尚未保存的成员调整？'))return;dirty.current=false;onClose();}
 function refresh(){if(busy.current)return;setError(null);setConflict(false);resource.refresh();}
 async function submit(values){
  if(busy.current||!impact||!permission||resource.error||resource.refreshing||stale||conflict||lastAdmin)return;
  const revokeSelf=member.id===state.currentMemberId&&(departing||mode==='transferAdmin'||mode==='setAccessRole'&&role!=='admin');
  if(revokeSelf&&onBeforeRevoke&&!onBeforeRevoke())return;
  busy.current=true;setPending(true);setError(null);
  try{const result=await api('/api/members/action',{projectId:state.project.id,expectedRevision:impact.revision,type:mode,...(mode==='leaveProject'?{}:{memberId:member.id}),...(mode==='setAccessRole'?{accessRole:values.accessRole}:{}),...(mode==='transferAdmin'||needsReplacement?{replacementMemberId:values.replacementMemberId}:{})});if(!alive.current)return;dirty.current=false;onSaved(result);onClose();}
  catch(err){if(alive.current){setError(err);if(err.status===409)setConflict(true);}}
  finally{busy.current=false;if(alive.current)setPending(false);}
 }
 return <Modal open centered title={TITLES[mode]} width={740} styles={{body:{maxHeight:'67vh',overflowY:'auto'}}} className="member-lifecycle-modal" closable={!pending} keyboard={!pending} mask={{closable:!pending}} onCancel={close} onOk={()=>form.submit()} confirmLoading={pending} cancelButtonProps={{disabled:pending}} okButtonProps={{disabled:!impact||!permission||Boolean(resource.error)||resource.refreshing||stale||conflict||lastAdmin||mode==='setAccessRole'&&role===impact.member.accessRole||(mode==='transferAdmin'||needsReplacement)&&!replacements.length}} okText={mode==='transferAdmin'?'确认转交管理权':departing?'确认处理并保留历史':'确认调整权限'}>
 {!impact?<ResourceState loading={!resource.error} error={resource.error} onRetry={refresh}/>:<><div className="member-impact-heading"><strong>{impact.member.name}</strong><Tag>{ROLES.find(item=>item.value===impact.member.accessRole)?.label||'仅分工档案'}</Tag><span>影响预览 · v{impact.revision}</span></div>
  {error&&<Alert type="error" showIcon title={error.message} description={conflict?'当前选择已保留。请重新核对最新影响，再确认操作。':undefined}/>}
  {(stale||conflict||resource.error)&&<Alert type="warning" showIcon title={resource.error?'影响信息暂未刷新':'项目已有新变化，请重新核对'} description={<><p>当前表单不会自动套用新的项目版本。刷新预览后，请检查责任清单和承接人再确认。</p><Button size="small" loading={resource.refreshing} disabled={pending} onClick={refresh}>重新核对影响</Button></>}/>}
  {!permission&&<Alert type="info" showIcon title="当前账号不能执行这项成员操作" description="请由有权限的项目管理员处理。"/>}
  {lastAdmin&&<Alert type="warning" showIcon title="至少保留一位已关联账号的项目管理员" description="请先转交管理权，或先将另一位已关联成员设为管理员，再降级、移除或退出。"/>}
  <p className="member-impact-explanation">{mode==='transferAdmin'?'接任者获得项目管理权限，原管理员降为项目成员并继续原分工。不会迁移任务。':departing?'成员退出后失去本项目访问，原人员、成果与讨论归属仍保留。未结束的推进与接收责任需先交接。工作区管理员仍保留必要的治理查看能力。':'项目权限与负责方向分别维护。调整为只读前，未结束的责任需由其他有效成员承接。'}</p>
  {(mode==='transferAdmin'||needsReplacement)&&!replacements.length&&<Alert type="warning" showIcon title="当前没有符合条件的承接人" description={mode==='transferAdmin'&&isDemo?'演示中的其他伙伴是未绑定档案，不能伪装成真实账号接任管理员。请在正式工作区邀请真实伙伴加入后再转交。':'请先让另一位可编辑成员加入项目；管理权接任者还需关联真实账号。当前操作不会强行移除责任。'}/>}
  <Form form={form} layout="vertical" disabled={pending||!permission} onValuesChange={()=>{dirty.current=true;setError(null);}} onFinish={submit}>
   {mode==='setAccessRole'&&<Form.Item name="accessRole" label="新的项目权限" rules={[{required:true,message:'请选择项目权限'}]}><Select options={ROLES.map(option=>({...option,disabled:option.value==='admin'&&!impact.member.accountLinked}))}/></Form.Item>}
   {(needsReplacement||mode==='transferAdmin')&&<Form.Item name="replacementMemberId" label={mode==='transferAdmin'?'接任管理员':'统一责任承接人'} rules={[{required:true,message:'请选择有效承接人'}]} extra={mode==='transferAdmin'?'仅可选择本项目中已关联账号、仍在项目内的成员。':'下方全部未结束任务中的负责人或接收人，将由此人统一承接。已有成果和历史提交人保持原归属。'}><Select showSearch optionFilterProp="label" placeholder="请选择伙伴" options={replacements.map(item=>({value:item.id,label:item.name}))}/></Form.Item>}
  </Form>
  <section className="member-impact-responsibilities"><h3>当前未结束的责任</h3><Space wrap><Tag>负责推进 {impact.responsibilities?.ownerCount||0} 项</Tag><Tag>成果接收 {impact.responsibilities?.reviewerCount||0} 项</Tag></Space>{impact.responsibilities?.tasks?.length?<Table rowKey="id" size="small" pagination={false} scroll={{x:540}} dataSource={impact.responsibilities.tasks} columns={[{title:'任务',render:(_,task)=><span>{task.code} · {task.title}</span>},{title:'当前责任',width:150,render:(_,task)=><Space size={4} wrap>{task.owner&&<Tag>负责人</Tag>}{task.reviewer&&<Tag>接收人</Tag>}</Space>},{title:'状态',dataIndex:'status',width:110,render:value=><StatusTag value={value}/>}]}/>:<p>没有需要迁移的未结束任务，历史记录会继续保留。</p>}</section>
 </>}
 </Modal>;
}
