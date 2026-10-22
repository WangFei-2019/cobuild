import {createHash} from 'node:crypto';
import {AppError} from './domain.mjs';

const cut=(value,max=300)=>typeof value==='string'?value.slice(0,max):'';
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:'';
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&stamp(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;

// This is a current-facts inbox, not a reconstructed complete event history.
// Callers provide active, authorized states; membership still gates each item.
export function deriveNotifications(identity,states,user,{now=new Date(),invitations=[]}={}) {
  if(!user?.personId)return [];
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(part=>[part.type,part.value]));
  const today=`${parts.year}-${parts.month}-${parts.day}`,end=new Date(today+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+7);
  const dueEnd=end.toISOString().slice(0,10),items=[];
  const add=(type,state,task,title,description,evidence,createdAt)=>{
    const projectId=state.project.id;if(!validId(projectId)||task&&!validId(task.id))return;
    const id=createHash('sha256').update(JSON.stringify([type,projectId,task?.id||'',evidence])).digest('hex');
    items.push({id,type,title:cut(title,220),description:cut(description,600),href:`/projects/${encodeURIComponent(projectId)}/${task?'tasks?task='+encodeURIComponent(task.id):'members'}`,
      createdAt:stamp(createdAt),projectId,projectName:cut(state.project.name,100),...(task?{taskId:task.id,taskCode:cut(task.code,30)}:{})});
    if(['mention','reply'].includes(type)&&validId(evidence?.[0])){items.at(-1).href+='&discussion='+encodeURIComponent(evidence[0]);items.at(-1).discussionId=evidence[0];}
  };
  for(const state of states){
    const membership=identity?.membership(state.project.id,user.personId),memberId=membership?.memberId;
    if(!state.members.some(member=>member.id===memberId&&member.active!==false))continue;
    const write=membership.accessRole!=='viewer';
    for(const task of state.tasks){
      if(task.status==='canceled')continue;
      const owned=task.ownerId===memberId,reviewing=task.reviewerId===memberId,artifact=task.artifacts?.[0],label=`${task.code||''} ${task.title||''}`.trim();
      if(write&&reviewing&&task.status==='review'&&artifact)add('review',state,task,'等待你接收：'+label,'核对最新成果「'+cut(artifact.name,200)+'」后确认接收或退回修改。',[artifact.id||artifact.createdAt,task.reviewerId],artifact.createdAt||task.updatedAt);
      if(write&&owned&&task.status==='blocked')add('blocked',state,task,'你的任务受阻：'+label,task.blocker||'请核对阻碍并补充需要的协助。',[task.blocker,task.ownerId],task.updatedAt);
      if(write&&owned&&task.status!=='done'&&day(task.due)&&task.due<=dueEnd)add('due',state,task,(task.due<today?'任务已逾期：':'任务即将到期：')+label,'约定截止：'+task.due+'。请核对实际进展；系统不预测完成时间。',[task.due,task.ownerId,task.due<today?'overdue':'upcoming'],task.updatedAt);
      const submitted=artifact?.submittedBy===memberId;
      if(owned||submitted){
        if(task.status==='done'&&stamp(task.acceptedAt)&&artifact){
          const event=state.activities?.find(item=>item.taskId===task.id&&item.kind==='accept');
          if(event?.actorId!==memberId)add('handoff_accepted',state,task,'成果已被接收：'+label,'最新成果「'+cut(artifact.name,200)+'」已有指定接收人的确认记录。',[artifact.id||artifact.createdAt,task.acceptedAt],task.acceptedAt);
        }
        const changes=state.activities?.find(item=>item.taskId===task.id&&['changes','artifact','accept'].includes(item.kind));
        if(owned&&task.status==='doing'&&changes?.kind==='changes'&&changes.actorId!==memberId)add('changes_requested',state,task,'成果需要修改：'+label,changes.text,[changes.id],changes.createdAt);
      }
      if(write&&owned&&['todo','doing'].includes(task.status)&&!items.some(item=>item.projectId===state.project.id&&item.taskId===task.id&&['due','changes_requested'].includes(item.type)))add('assigned',state,task,'待你推进：'+label,task.deliverable||'请核对本任务的交付约定，并记录实际进展。',[task.ownerId],task.updatedAt);
    }
  }
  for(const state of states){
    const link=identity?.membership(state.project.id,user.personId),memberId=link?.memberId;
    if(!state.members.some(member=>member.id===memberId&&member.active!==false))continue;
    for(const entry of state.discussions||[]){
      if(entry.authorId===memberId||!state.members.some(member=>member.id===entry.authorId))continue;
      const task=state.tasks.find(item=>item.id===entry.taskId);if(!task||task.status==='canceled')continue;
      const parent=entry.replyTo?(state.discussions||[]).find(item=>item.id===entry.replyTo&&item.taskId===entry.taskId):null;
      const type=entry.mentionIds?.includes(memberId)?'mention':parent?.authorId===memberId?'reply':null;
      if(type)add(type,state,task,type==='mention'?'有人在任务讨论中提到你':'你的任务讨论收到回复',entry.body,[entry.id],entry.createdAt);
    }
  }
  for(const invitation of invitations){
    const state=states.find(item=>item.project.id===invitation.projectId);
    if(state&&invitation.status==='accepted')add('invitation_accepted',state,null,'项目邀请已被接受',cut(invitation.memberName,40)?invitation.memberName+'已接受你发出的项目邀请。':'你发出的项目邀请已有接受记录。',[invitation.id],invitation.acceptedAt);
  }
  return items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
}

export function notificationView(items,readIds){
  const rows=items.map(item=>({...item,read:readIds.has(item.id)})).sort((a,b)=>Number(a.read)-Number(b.read)||b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
  return {items:rows.slice(0,500),unreadCount:rows.filter(item=>!item.read).length,total:rows.length,hasMore:rows.length>500};
}
export function notificationReadIds(input,items){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('通知已读请求格式不正确');
  const keys=Object.keys(input);
  if(keys.length===1&&input.all===true)return items.map(item=>item.id);
  if(keys.length!==1||keys[0]!=='ids'||!Array.isArray(input.ids)||input.ids.length>500||input.ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw new AppError('仅支持 ids 通知编号列表或 all:true');
  const visible=new Set(items.map(item=>item.id));if(input.ids.some(id=>!visible.has(id)))throw new AppError('通知已不可用，请刷新当前通知后重试',404);
  return [...new Set(input.ids)];
}
