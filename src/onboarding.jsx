import React,{useEffect,useRef,useState} from 'react';
import {Alert,Button,Modal,Select,Space,Steps,Tag} from 'antd';
import {ArrowRightOutlined,CheckCircleOutlined,FileDoneOutlined,FlagOutlined,LinkOutlined,PlusOutlined,ProjectOutlined,ReadOutlined,RobotOutlined,TeamOutlined} from '@ant-design/icons';
import {api,isDemo,safeColor} from './lib.js';
import {guideProjectModel} from './onboarding-model.js';
import {SampleCreateButton} from './sample-project.jsx';
import './onboarding.css';

const STEPS=[{title:'找到项目'},{title:'约定分工'},{title:'完成交接'}];

export default function OnboardingGuide({user,workspace,preferredProjectId,onboarding,onStatusSaved,onClose,onAction}){
 const [step,setStep]=useState(0),[selectedId,setSelectedId]=useState(preferredProjectId||workspace.projects[0]?.id),[saving,setSaving]=useState(false),[failure,setFailure]=useState(null);
 const alive=useRef(true),pending=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const projects=workspace.projects,project=projects.find(item=>item.id===selectedId)||projects[0],projectModel=guideProjectModel(project,{demo:isDemo});
 const canCreate=workspace.permissions?.createProject===true||isDemo&&workspace.permissions?.createProject!==false;
 const status=onboarding?.status||'pending';

 async function finish(nextStatus,action=null){
  if(pending.current)return;
  pending.current=true;setSaving(true);setFailure(null);
  try{
   if(status==='pending'||nextStatus==='completed'&&status!=='completed'){
    const result=await api('/api/auth/onboarding',{status:nextStatus});
    if(result.onboarding?.version!==1||!['dismissed','completed'].includes(result.onboarding.status))throw new Error('服务未返回有效的指引保存结果，请重试。');
    if(!alive.current)return;
    onStatusSaved(result.onboarding);
   }
   if(!alive.current)return;
   if(action?.kind==='sample'){
    const created=await onAction(action);
    if(!alive.current)return;
    if(created===false){setFailure({kind:'action',message:'未能准备示例项目。可以继续阅读或重试，不会重置指引状态。',status:nextStatus,action});return;}
   }
   onClose();
   if(action&&action.kind!=='sample')onAction(action);
  }catch(error){if(alive.current)setFailure({kind:'save',message:error.message||'暂时无法保存阅读状态，请重试。',status:nextStatus,action});}
  finally{pending.current=false;if(alive.current)setSaving(false);}
 }
 const act=(tab,label)=>finish('dismissed',{kind:'project',projectId:project.id,tab,label:`${project.name} · ${label}`});
 const create=()=>finish('dismissed',{kind:'create',label:'创建项目'});
 const picker=project&&<div className="guide-project-picker"><label htmlFor="guide-project-select">当前指引项目</label><Select id="guide-project-select" aria-label="选择指引项目" value={project.id} disabled={saving} onChange={setSelectedId} options={projects.map(item=>({value:item.id,label:item.name}))} optionRender={option=><span className="guide-project-option"><i style={{background:safeColor(projects.find(item=>item.id===option.value)?.color)}}/>{option.label}</span>}/></div>;

 return <Modal open centered title={<span className="guide-modal-title"><ReadOutlined/> 使用指引</span>} width={680} className="onboarding-modal" onCancel={()=>finish('dismissed')} closable={!saving} keyboard={!saving} mask={{closable:false}} footer={null}>
  <div className="guide-intro"><span>{user.name}，欢迎使用共建</span><Tag>{isDemo?'本机演示指引':'约 1 分钟'}</Tag></div>
  <Steps size="small" current={step} items={STEPS} responsive={false} className="guide-steps"/>
  <div className="guide-page" aria-live="polite">
   {step===0&&<>
    <div className="guide-page-heading"><ProjectOutlined/><div><h2>先找到一个共同目标</h2><p>一个项目承载目标、伙伴、任务和成果。你可以自己发起，也可以接受伙伴的邀请。</p></div></div>
    <section className="guide-instruction"><h3><PlusOutlined/> 创建自己的项目</h3><p>写下要解决的问题、共同目标和期限；创建后再邀请伙伴、安排第一项分工。</p>{canCreate?<Button icon={<PlusOutlined/>} disabled={saving} onClick={create}>创建项目</Button>:<p className="guide-permission-note">当前账号的项目创建权限由工作区管理员维护。</p>}</section>
    {canCreate&&<section className="guide-sample-entry"><SampleCreateButton workspace={workspace} disabled={saving} onClick={()=>finish('dismissed',{kind:'sample',label:'准备示例项目'})}/><p>加入你的工作区，含虚拟伙伴，不邀请真实伙伴；可删除并恢复。已有示例会打开，已删除的示例会保留修改恢复。</p></section>}
    <section className="guide-instruction"><h3><LinkOutlined/> 加入伙伴的项目</h3><p>{isDemo?'本地演示不生成真实邀请。可以在项目成员页添加本地档案，体验分工与成果交接。':'请让项目管理员分享本服务的真实邀请链接。普通注册或登录不会自动加入他人项目；通过邀请页注册会同时接受该邀请，已有账号需在邀请页确认接受。'}</p></section>
    {picker&&<div className="guide-existing-project">{picker}<Button disabled={saving} onClick={()=>act('overview','项目总览')}>打开这个项目<ArrowRightOutlined/></Button></div>}
   </>}
   {step===1&&<>
    <div className="guide-page-heading"><TeamOutlined/><div><h2>把目标变成可交接的分工</h2><p>每项任务先约定谁推进、谁接收，以及需要交付什么；里程碑把这些任务串成阶段目标。</p></div></div>
    {picker}
    {projectModel?<div className="guide-action-list">{projectModel.actions.map(item=><section key={item.key}><span className="guide-action-icon">{item.key==='members'?<TeamOutlined/>:item.key==='milestones'?<FlagOutlined/>:<CheckCircleOutlined/>}</span><div><h3>{item.label}</h3><p>{item.description}</p></div><Button size="small" disabled={saving} aria-label={`进入${project.name}：${item.label}`} onClick={()=>act(item.tab,item.label)}>前往<ArrowRightOutlined/></Button></section>)}</div>:<div className="guide-no-project"><ProjectOutlined/><p>创建或加入项目后，就能查看成员、任务和里程碑。现在也可以继续阅读交接流程。</p>{canCreate&&<Button disabled={saving} onClick={create}>创建第一个项目</Button>}</div>}
    <div className="guide-optional"><RobotOutlined/><p><strong>AI 规划是可选辅助。</strong>{isDemo?'内置规划草案是本地固定示例，不是实时 AI 生成。':'没有配置模型也可以手动规划，或将项目上下文交给外部 AI。'}{projectModel?.manager?'模型或外部方案都要经校验、编辑和确认，才会写入项目。':'规划写入由项目管理员确认；你可以先查看阶段与分工。'}</p></div>
   </>}
   {step===2&&<>
    <div className="guide-page-heading"><FileDoneOutlined/><div><h2>交付成果，再确认完成</h2><p>进度更新用于同步过程；成果验收用于确认实际交付。任务的接收人决定是否接收或退回修改。</p></div></div>
    <div className="guide-handoff-flow"><span>提交成果</span><ArrowRightOutlined/><span>待交接</span><ArrowRightOutlined/><span>确认接收或退回</span></div>
    <section className="guide-instruction"><h3>作为负责人</h3><p>打开任务详情，按约定提交文件、链接或文字成果。遇到受阻时记录原因和需要的协助；被退回后按意见补充，再重新提交。</p></section>
    <section className="guide-instruction"><h3>作为成果接收人</h3><p>查看最新成果，对照交付要求确认接收或退回并说明意见。只有该任务指定的接收人可以验收，项目管理员不能代替接收人确认。</p></section>
    {picker}{project&&<Space wrap className="guide-handoff-actions"><Button disabled={saving} onClick={()=>act('tasks','任务约定')}>查看任务约定<ArrowRightOutlined/></Button><Button disabled={saving} onClick={()=>act('deliverables','项目成果')}>查看项目成果<ArrowRightOutlined/></Button></Space>}
    {projectModel?.readOnly&&<p className="guide-permission-note">当前项目为只读访问，可查看分工和成果；提交与验收需要相应任务权限。</p>}
    {!project&&<p className="guide-permission-note">加入或创建项目后，就可以在任务页和交付成果页查看实际交接记录。</p>}
   </>}
  </div>
  {failure&&<Alert className="guide-save-error" type="warning" showIcon title={failure.kind==='action'?'示例项目暂未准备好':'指引状态尚未保存'} description={<><p>{failure.message}</p>{failure.action&&failure.kind!=='action'&&<p>重试保存成功后将继续：{failure.action.label}。直接关闭不会执行这项操作。</p>}<Space wrap><Button size="small" loading={saving} onClick={()=>finish(failure.status,failure.action)}>{failure.kind==='action'?'重试准备示例':'重试保存'}</Button><Button size="small" disabled={saving} onClick={onClose}>{failure.kind==='action'?'先关闭':'先关闭，下次提醒'}</Button></Space>{failure.kind!=='action'&&<small>{isDemo?'本机状态未保存，下次打开演示仍可能提醒。':'仅关闭本次指引；状态未保存，下次登录仍可能提醒。'}</small>}</>}/>}
  <footer className="guide-footer"><Button type="text" disabled={saving} onClick={()=>finish('dismissed')}>暂时跳过</Button><Space>{step>0&&<Button disabled={saving} onClick={()=>setStep(value=>value-1)}>上一步</Button>}{step<2?<Button type="primary" disabled={saving} onClick={()=>setStep(value=>value+1)}>下一步<ArrowRightOutlined/></Button>:<Button type="primary" loading={saving} onClick={()=>finish('completed')}>了解了</Button>}</Space></footer>
  <p className="guide-reopen-note">{isDemo?'指引状态仅保存在当前浏览器。':'阅读状态保存在当前账号。'}以后可从右上角菜单重新打开「使用指引」。</p>
 </Modal>;
}
