import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deriveNotifications,notificationView,notificationReadIds} from '../notifications.mjs';
import {createNotificationStore} from '../notification-store.mjs';

const at='2030-03-01T08:00:00.000Z',now=new Date(at),user={id:'account-one',personId:'person-one'};
const identity={membership:(projectId,personId)=>personId==='person-one'?{memberId:'m1',accessRole:'member'}:null};
const state=()=>({project:{id:'project-one',name:'我的项目'},members:[{id:'m0'},{id:'m1'}],activities:[],tasks:[
  {id:'task-review',code:'CB-101',title:'待接收',ownerId:'m0',reviewerId:'m1',status:'review',updatedAt:at,artifacts:[{id:'artifact-one',name:'第一版',createdAt:at,submittedBy:'m0'}]},
  {id:'task-blocked',code:'CB-102',title:'受阻',ownerId:'m1',reviewerId:'m0',status:'blocked',blocker:'等待资料',due:'2030-03-02',updatedAt:at,artifacts:[]},
  {id:'task-unrelated',title:'其他人',ownerId:'m0',reviewerId:'m0',status:'blocked',blocker:'不应通知我',due:'2030-03-01',updatedAt:at,artifacts:[]}
]});

test('通知只派生本人当前事项，ID稳定且新成果重新提示，不将管理员可见等同于本人分工',()=>{
  const data=state(),before=structuredClone(data),items=deriveNotifications(identity,[data],user,{now});
  assert.deepEqual(items.map(item=>item.type).sort(),['blocked','due','review']);assert.deepEqual(data,before);
  assert.ok(items.every(item=>item.href.startsWith('/projects/project-one/tasks?task=')&&!item.description.includes('不应通知我')));
  assert.equal(deriveNotifications({membership:()=>null},[data],{...user,workspaceRole:'admin'},{now}).length,0);
  assert.equal(deriveNotifications({membership:()=>({memberId:'m1',accessRole:'viewer'})},[data],user,{now}).length,0);
  const old=items.find(item=>item.type==='review');data.tasks[0].updatedAt='2030-03-01T09:00:00Z';
  assert.equal(deriveNotifications(identity,[data],user,{now}).find(item=>item.type==='review').id,old.id);
  data.tasks[0].artifacts.unshift({id:'artifact-two',name:'新版',createdAt:'2030-03-01T10:00:00Z'});
  assert.notEqual(deriveNotifications(identity,[data],user,{now}).find(item=>item.type==='review').id,old.id);
});

test('通知结果基于真实交接和退回记录，已解决事项消失，邀请不构造令牌链接',()=>{
  const data=state();data.tasks[0]={...data.tasks[0],ownerId:'m1',reviewerId:'m0',status:'done',acceptedAt:at};
  data.activities=[{id:'event-accept',taskId:'task-review',kind:'accept',actorId:'m0',createdAt:at}];
  let items=deriveNotifications(identity,[data],user,{now,invitations:[{id:'invite-one',projectId:'project-one',status:'accepted',acceptedAt:at,memberName:'已加入的人'}]});
  assert.ok(items.some(item=>item.type==='handoff_accepted'));assert.equal(items.find(item=>item.type==='invitation_accepted').href,'/projects/project-one/members');
  data.tasks[0].status='doing';data.activities.unshift({id:'event-change',taskId:'task-review',kind:'changes',actorId:'m0',text:'请补齐步骤',createdAt:at});
  items=deriveNotifications(identity,[data],user,{now});assert.ok(items.some(item=>item.type==='changes_requested'));assert.ok(!items.some(item=>item.type==='handoff_accepted'));
  data.activities.unshift({id:'event-new',taskId:'task-review',kind:'artifact',actorId:'m1',createdAt:at});
  assert.ok(!deriveNotifications(identity,[data],user,{now}).some(item=>item.type==='changes_requested'));
});

test('账号已读独立持久化，未知或失权ID拒绝且不写入，读取/已读不修改项目',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cobuild-notifications-'));let store;
  try {const data=state(),before=structuredClone(data),items=deriveNotifications(identity,[data],user,{now});store=createNotificationStore(dir);
    assert.equal(store.view('a',items).unreadCount,3);const first=items[0].id;
    assert.equal(store.mark('a',{ids:[first]},items).unreadCount,2);assert.equal(store.view('b',items).unreadCount,3);
    assert.throws(()=>store.mark('a',{ids:['a'.repeat(64)]},items),error=>error.status===404);assert.equal(store.view('a',items).unreadCount,2);
    for(const input of [{all:false},{ids:[],accountId:'b'},{all:true,ids:[]},null,{ids:['bad']}])assert.throws(()=>notificationReadIds(input,items));
    store.close();store=createNotificationStore(dir);assert.equal(store.view('a',items).unreadCount,2);
    assert.equal(store.mark('a',{all:true},items).unreadCount,0);assert.equal(store.view('a',[]).unreadCount,0);assert.deepEqual(data,before);
  }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('通知有界且未读优先，不伪造未知时间，全部已读范围使用全部当前授权事项',()=>{
  const items=Array.from({length:510},(_,index)=>({id:index.toString(16).padStart(64,'0'),createdAt:at}));
  const read=new Set(items.slice(0,500).map(item=>item.id)),view=notificationView(items,read);
  assert.equal(view.total,510);assert.equal(view.items.length,500);assert.equal(view.unreadCount,10);assert.equal(view.hasMore,true);assert.equal(view.items[0].read,false);
  assert.equal(notificationReadIds({all:true},items).length,510);
});

test('没有近期截止的本人待办仍提示当前分工，历史提交人不冒领最新成果的接收结果',()=>{
  const data=state();data.tasks=[{id:'assigned',title:'长期任务',ownerId:'m1',reviewerId:'m0',status:'todo',artifacts:[],updatedAt:at}];
  const one=deriveNotifications(identity,[data],user,{now});assert.equal(one.length,1);assert.equal(one[0].type,'assigned');assert.match(one[0].title,/待你推进/);
  data.tasks[0].due='2030-03-02';assert.deepEqual(deriveNotifications(identity,[data],user,{now}).map(item=>item.type),['due']);
  data.tasks=[{id:'old-submit',ownerId:'m0',reviewerId:'m0',status:'done',acceptedAt:at,artifacts:[{id:'latest',name:'他人的新版',submittedBy:'m0'},{id:'old',submittedBy:'m1'}]}];
  assert.equal(deriveNotifications(identity,[data],user,{now}).length,0);
});
