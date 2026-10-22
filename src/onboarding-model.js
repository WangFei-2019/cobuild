export function canAutoOpenGuide(route){
 return Boolean(route&&!route.taskId&&(route.kind==='dashboard'||route.kind==='projects'||route.kind==='project'&&(route.tab||'overview')==='overview'));
}

export function mergeOnboardingSession(session,accountId,onboarding){
 if(!session?.user||session.user.id!==accountId)return session;
 return {...session,onboarding:session.onboarding?.status==='completed'?{...onboarding,status:'completed'}:onboarding};
}

export function guideProjectModel(project,{demo=false}={}){
 if(!project)return null;
 const permissions=project.permissions||(demo?{manageProject:true,createTask:true,readOnly:false}:{});
 const readOnly=permissions.readOnly===true||!project.permissions&&!demo;
 const manager=!readOnly&&permissions.manageProject===true;
 const sample=project.sample?.version===1,manageMembers=manager&&permissions.manageMembers!==false&&!sample;
 const canCreateTask=!readOnly&&(manager||permissions.createTask===true);
 return {manager,canCreateTask,readOnly,actions:[
  {key:'tasks',tab:'tasks',label:canCreateTask?'安排任务分工':'查看任务约定',description:canCreateTask?'在任务页新建分工，写清负责人、成果接收人、截止日期与交付物。':'查看负责人、成果接收人和交付要求，找到自己需要推进的任务。'},
  {key:'members',tab:'members',label:sample?'查看虚拟伙伴':manageMembers?(demo?'添加本地人员':'邀请伙伴与分配职责'):'查看伙伴职责',description:sample?'示例伙伴为固定虚拟档案，不邀请真实账号；真实协作请创建自己的空白项目。':manageMembers?(demo?'本地档案用于体验分工，不产生真实账号或远程访问。':'在成员页生成邀请链接；伙伴接受后获得项目访问。人员档案用于记录分工。'):'查看项目成员与负责方向；邀请和权限由项目管理员维护。'},
  {key:'milestones',tab:'milestones',label:manager?'制定里程碑':'查看阶段目标',description:manager?'把目标分成可验收阶段，再关联已有任务。里程碑以实际交接结果验收。':'了解各阶段目标和验收标准；里程碑由项目管理员维护。'}
 ]};
}
