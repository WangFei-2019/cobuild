import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState, AppError } from '../domain.mjs';
import { peopleSummary, personDetails, projectWithProfiles } from '../people.mjs';

function fixture() {
  const a = seedState(); a.project.color = '#123456';
  const b = seedState(); b.project.id = 'p2'; b.project.name = '第二个项目'; b.project.color = '#9067c6'; b.tasks = []; b.activities = [];
  const people = [{ id: 'person-a', name: '同名', color: '#aaa', accountLinked: true },
    { id: 'person-b', name: '同名', color: '#bbb', accountLinked: false },
    { id: 'person-hidden', name: '不可见成员', color: '#ccc', accountLinked: true }];
  const links = new Map([['p1:m2', 'person-a'], ['p2:m1', 'person-a'], ['p1:m1', 'person-b']]);
  const identity = { people: () => people, person: id => { const person = people.find(p => p.id === id); if (!person) throw new AppError('没有找到这个成员档案', 404); return person; },
    member: (projectId, memberId) => links.has(`${projectId}:${memberId}`) ? { personId: links.get(`${projectId}:${memberId}`), accessRole: 'member' } : null };
  return { a, b, identity };
}

test('跨项目个人统计按统一ID与真实项目色聚合，同名人员不合并，空任务无虚假100%', () => {
  const { a, b, identity } = fixture();
  const detail = personDetails(identity, [a, b], { personId: 'person-a' }, 'person-a');
  assert.equal(detail.projects.length, 2);
  assert.deepEqual(detail.projects.map(p => p.project.color), ['#123456', '#9067c6']);
  assert.equal(detail.projects[1].stats.progress, null);
  assert.equal(detail.summary.taskCount, a.tasks.filter(t => t.ownerId === 'm2').length);
  assert.ok(detail.tasks.every(t => t.project.id === 'p1'));
  assert.ok(detail.artifacts.every(a => a.attribution === 'taskOwner' && a.attributionLabel.includes('历史')));
  const all = peopleSummary(identity, [a, b], { workspaceRole: 'admin' });
  assert.equal(all.filter(p => p.name === '同名').length, 2);
  assert.equal(all.find(p => p.id === 'person-b').projectCount, 1);
});

test('个人页只聚合可见项目；普通用户不能通过档案ID枚举其他人员', () => {
  const { a, b, identity } = fixture();
  const visible = peopleSummary(identity, [a], { personId: 'person-a', workspaceRole: 'member' });
  assert.equal(visible.length, 2);
  assert.equal(visible.find(p => p.id === 'person-a').projectCount, 1);
  assert.ok(!JSON.stringify(visible).includes(b.project.name));
  assert.throws(() => personDetails(identity, [a], { personId: 'person-a' }, 'person-hidden'), e => e.status === 404);
  assert.equal(personDetails(identity, [], { personId: 'person-hidden' }, 'person-hidden').summary.progress, null);
});

test('成果区分实际提交人和历史任务归属，只有已确认的最新成果显示接收时间', () => {
  const { a, identity } = fixture();
  a.tasks[0].artifacts = [
    { id: 'v2', name: '新版', submittedBy: 'm2', createdAt: '2026-10-21T00:00:00Z' },
    { id: 'v1', name: '旧版', submittedBy: 'm2', createdAt: '2026-10-20T00:00:00Z' }
  ];
  a.tasks[0].status = 'done'; a.tasks[0].acceptedAt = '2026-10-22T00:00:00Z';
  const detail = personDetails(identity, [a], { personId: 'person-a' }, 'person-a');
  const latest = detail.artifacts.find(x => x.id === 'v2'), old = detail.artifacts.find(x => x.id === 'v1');
  assert.equal(latest.attribution, 'submittedBy');
  assert.equal(latest.acceptanceStatus, 'accepted');
  assert.equal(latest.acceptedAt, a.tasks[0].acceptedAt);
  assert.equal(old.acceptanceStatus, 'historical');
  assert.equal(old.acceptedAt, '');
  assert.equal(detail.tasks.find(t => t.id === a.tasks[0].id).relation, 'contributor');
});

test('同一人员离开后以新成员编号回归只算一个项目，保留旧提交与历史快照且不重复任务', () => {
  const { a, identity } = fixture();
  const departed=a.members.find(member=>member.id==='m2');
  departed.active=false;departed.leftAt='2026-10-22T00:00:00Z';departed.name='离开时姓名';
  a.members.push({...departed,id:'rejoined',name:'新成员姓名',role:'新的负责方向',active:true,leftAt:''});
  const oldMember=identity.member;
  identity.member=(projectId,memberId)=>memberId==='rejoined'?{personId:'person-a',accessRole:'admin'}:oldMember(projectId,memberId);
  a.tasks.forEach(task=>{task.artifacts=[];});
  const task=a.tasks[0];task.ownerId='rejoined';task.reviewerId='m2';task.artifacts=[
    {id:'before-leaving',name:'离开前成果',submittedBy:'m2',createdAt:'2026-10-21T00:00:00Z'},
    {id:'after-rejoin',name:'回归后成果',submittedBy:'rejoined',createdAt:'2026-10-22T00:00:00Z'}
  ];
  a.activities=[{id:'before-activity',actorId:'m2',taskId:task.id,createdAt:'2026-10-21T00:00:00Z'},
    {id:'after-activity',actorId:'rejoined',taskId:task.id,createdAt:'2026-10-22T00:00:00Z'}];
  const original=structuredClone(a),user={personId:'person-a'};
  const row=peopleSummary(identity,[a],user).find(person=>person.id==='person-a');
  const detail=personDetails(identity,[a],user,'person-a');
  assert.equal(row.projectCount,1);assert.equal(row.projects.length,1);assert.equal(detail.projects.length,1);
  assert.equal(row.projects[0].memberId,'rejoined');assert.equal(row.projects[0].accessRole,'admin');assert.equal(row.projects[0].role,'新的负责方向');
  assert.deepEqual(row.projects[0].historicalMemberIds,['m2']);assert.equal(row.projects[0].active,true);
  assert.equal(detail.tasks.filter(item=>item.id===task.id).length,1);assert.equal(detail.tasks.find(item=>item.id===task.id).relation,'owner-reviewer');
  assert.deepEqual(detail.artifacts.map(item=>item.id).sort(),['after-rejoin','before-leaving']);
  assert.equal(detail.summary.artifactCount,2);assert.equal(detail.activities.length,2);
  assert.equal(projectWithProfiles(a,identity).members.find(member=>member.id==='m2').name,'离开时姓名');
  assert.deepEqual(a,original);
});
