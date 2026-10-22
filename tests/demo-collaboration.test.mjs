import test from 'node:test';import assert from 'node:assert/strict';
import {createDemoAPI,DEMO_STORAGE_KEY} from '../src/demo-api.js';
const fixture=()=>{const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},demo=createDemoAPI({storage,now:()=>new Date('2030-03-01T00:00:00Z')});return {values,storage,demo};};

test('浏览器演示取消从待办与完成率移出，保存原因、依赖影响和恢复历史，重载不重置',async()=>{
 const {demo,storage}=fixture();let state=(await demo.request('/api/projects',{name:'取消恢复的本地项目'})).state;const projectId=state.project.id;
 state=(await demo.request('/api/action',{projectId,type:'createTask',title:'待取消的重复工作',ownerId:state.currentMemberId,reviewerId:state.currentMemberId,deliverable:'明确检查步骤',due:'2030-03-03'})).state;
 const first=state.tasks[0];state=(await demo.request('/api/action',{projectId,type:'createTask',title:'保留的后续工作',ownerId:state.currentMemberId,reviewerId:state.currentMemberId,deliverable:'后续结果',due:'2030-03-04',dependsOn:[first.id]})).state;
 state=(await demo.request('/api/action',{projectId,type:'cancelTask',taskId:first.id,taskUpdatedAt:first.updatedAt,reason:'确认与现有工作重复'})).state;
 assert.equal(state.tasks[0].status,'canceled');assert.equal(state.tasks[1].dependsOn[0],first.id);
 const workspace=await demo.request('/api/workspace'),meta=workspace.projects.find(p=>p.id===projectId);assert.equal(meta.taskCount,1);assert.equal(meta.doneCount,0);assert.equal(meta.canceledCount,1);
 assert.equal((await demo.request('/api/dashboard')).sections.todo.some(t=>t.id===first.id),false);assert.equal((await demo.request('/api/notifications')).items.some(t=>t.taskId===first.id),false);
 const before=storage.getItem(DEMO_STORAGE_KEY);await assert.rejects(demo.request('/api/action',{projectId,type:'setStatus',taskId:first.id,status:'doing'}));assert.equal(storage.getItem(DEMO_STORAGE_KEY),before);
 assert.match(await (await demo.download('/api/report?projectId='+projectId)).blob.text(),/确认与现有工作重复/);
 state=await createDemoAPI({storage}).request('/api/state?projectId='+projectId);state=(await demo.request('/api/action',{projectId,type:'restoreTask',taskId:first.id,taskUpdatedAt:state.tasks[0].updatedAt})).state;
 assert.equal(state.tasks[0].status,'todo');assert.ok(state.tasks[0].cancelHistory[0].restoredAt);assert.equal((await demo.request('/api/workspace')).projects.find(p=>p.id===projectId).taskCount,2);
});

test('演示讨论可回复与解决问题，提及必须项目有效成员，发表不会污染交付快照',async()=>{
 const {demo,storage}=fixture();let state=await demo.request('/api/state'),task=state.tasks.find(t=>t.status==='todo');const projectId=state.project.id,updatedAt=task.updatedAt;
 state=(await demo.request('/api/action',{projectId,type:'addDiscussion',taskId:task.id,kind:'question',body:'请确认这个验收范围？',mentionIds:[state.members.find(m=>m.id!==state.currentMemberId).id]})).state;
 const question=state.discussions.find(d=>d.body==='请确认这个验收范围？');assert.equal(state.tasks.find(t=>t.id===task.id).updatedAt,updatedAt);
 state=(await demo.request('/api/action',{projectId,type:'addDiscussion',taskId:task.id,body:'补充一个可重复的核对步骤。',replyTo:question.id})).state;assert.equal(state.discussions.find(d=>d.replyTo===question.id).kind,'comment');
 const before=storage.getItem(DEMO_STORAGE_KEY);await assert.rejects(demo.request('/api/action',{projectId,type:'addDiscussion',taskId:task.id,body:'非法提及',mentionIds:['other-project-member']}));assert.equal(storage.getItem(DEMO_STORAGE_KEY),before);
 state=(await demo.request('/api/action',{projectId,type:'resolveDiscussion',discussionId:question.id,expectedRevision:state.revision})).state;assert.ok(state.discussions.find(d=>d.id===question.id).resolved);
 const loaded=await createDemoAPI({storage}).request('/api/state?projectId='+projectId);assert.equal(loaded.discussions.length,2);assert.equal(loaded.tasks.find(t=>t.id===task.id).updatedAt,updatedAt);
 assert.match(await (await demo.download('/api/report?projectId='+projectId)).blob.text(),/请确认这个验收范围/);
});

test('演示成员移除原子交接并保留历史，最后账号管理员不能退出，离开后的治理身份不能写任务',async()=>{
 const {demo,storage,values}=fixture();let state=await demo.request('/api/state');const projectId=state.project.id,target=state.members.find(m=>m.id==='m1');
 let impact=await demo.request('/api/members/impact?projectId='+projectId+'&memberId='+target.id);assert.ok(impact.responsibilities.tasks.length>0);
 state=(await demo.request('/api/members/action',{projectId,expectedRevision:impact.revision,type:'removeMember',memberId:target.id,replacementMemberId:state.currentMemberId})).state;
 assert.equal(state.members.find(m=>m.id===target.id).active,false);assert.ok(state.tasks.some(t=>t.ownerId===target.id&&t.status==='done'));
 assert.equal(state.tasks.some(t=>!['done','canceled'].includes(t.status)&&(t.ownerId===target.id||t.reviewerId===target.id)),false);
 assert.equal((await createDemoAPI({storage}).request('/api/state?projectId='+projectId)).members.find(m=>m.id===target.id).active,false);
 let before=storage.getItem(DEMO_STORAGE_KEY);await assert.rejects(demo.request('/api/members/action',{projectId,expectedRevision:state.revision,type:'leaveProject'}),e=>e.status===409);assert.equal(storage.getItem(DEMO_STORAGE_KEY),before);
 // Test-only fixture adds a second synthetic linked administrator; the real
 // public demo still offers one local identity and no registration or invites.
 const doc=JSON.parse(before),nextAdmin=state.members.find(m=>m.id==='m2'),binding=doc.bindings[projectId][nextAdmin.id];doc.people.find(p=>p.id===binding.personId).accountLinked=true;binding.accessRole='admin';values.set(DEMO_STORAGE_KEY,JSON.stringify(doc));
 state=(await demo.request('/api/members/action',{projectId,expectedRevision:state.revision,type:'leaveProject',replacementMemberId:nextAdmin.id})).state;
 assert.equal(state.currentMemberId,null);assert.equal(state.permissions.readOnly,true);assert.equal(state.permissions.manageProject,false);assert.equal(state.permissions.manageMembers,true);
 before=storage.getItem(DEMO_STORAGE_KEY);await assert.rejects(demo.request('/api/action',{projectId,type:'createTask',title:'不应写入',ownerId:nextAdmin.id,reviewerId:nextAdmin.id,deliverable:'不应写入'}),e=>e.status===403);assert.equal(storage.getItem(DEMO_STORAGE_KEY),before);
 const reopened=await createDemoAPI({storage}).request('/api/state?projectId='+projectId);assert.equal(reopened.currentMemberId,null);assert.equal(reopened.members.find(m=>m.id===state.members.find(x=>x.active===false&&x.id!==target.id).id).active,false);
});
