import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardSummary } from '../dashboard.mjs';

const now = new Date('2026-10-20T16:30:00.000Z');
const user = { personId: 'person-current' };
const identity = { membership: projectId => ({ memberId: projectId === 'a' ? 'm1' : 'm7' }) };
const task = (id, extra = {}) => ({ id, code: `CB-${id}`, title: id, ownerId: 'm1', reviewerId: 'm2', status: 'todo', due: '2026-10-21', ...extra });
const state = (id, tasks) => ({ project: { id, name: id, color: '#123456' }, members: [{ id: 'm1', name: '一' }, { id: 'm2', name: '二' }, { id: 'm7', name: '七' }], tasks });

test('工作台按真实跨项目映射聚合，上海日期边界、临期与逾期明确，搜索不改变统计', () => {
  const a = state('a', [task('old', { due: '2026-10-20' }), task('today', { status: 'review' }),
    task('seventh', { due: '2026-10-28', status: 'blocked', blocker: '待确认' }), task('eighth', { due: '2026-10-29' }),
    task('review', { ownerId: 'm2', reviewerId: 'm1', status: 'review', description: 'ＫＥＹ 查找', artifacts: [{ note: '不回传成果原文' }] }),
    task('done', { status: 'done', due: '2026-10-01' })]);
  const b = state('b', [task('same-local-id'), task('my-other-project', { ownerId: 'm7', due: '' })]);
  const result = dashboardSummary(identity, [a, b], user, { now, query: ' key ' });
  assert.equal(result.today, '2026-10-21');
  assert.deepEqual(result.summary, { todo: 5, toReview: 1, blocked: 1, dueSoon: 4 });
  assert.equal(result.sections.todo.find(row => row.id === 'today').status, 'review');
  assert.ok(!result.sections.todo.some(row => row.id === 'same-local-id'));
  assert.equal(result.sections.todo.find(row => row.id === 'my-other-project').currentMemberId, 'm7');
  assert.equal(result.sections.dueSoon.find(row => row.id === 'old').isOverdue, true);
  assert.equal(result.sections.dueSoon.find(row => row.id === 'old').isDueSoon, false);
  assert.equal(result.sections.dueSoon.find(row => row.id === 'seventh').isDueSoon, true);
  assert.ok(!result.sections.dueSoon.some(row => ['eighth', 'done'].includes(row.id)));
  assert.equal(result.search.total, 1);
  assert.equal(result.search.tasks[0].relation, 'reviewer');
  assert.ok(!JSON.stringify(result).includes('不回传成果原文'));
  assert.equal(Object.hasOwn(result.search.tasks[0], 'description'), false);
  assert.deepEqual(dashboardSummary(identity, [a, b], user, { now }).summary, result.summary);
});

test('工作台搜索与分区有稳定上限，空搜索为空，不把无绑定旧档案算给本人', () => {
  const tasks = Array.from({ length: 205 }, (_, i) => task(String(i).padStart(3, '0'), { title: 'needle' })).reverse();
  const result = dashboardSummary(identity, [state('a', tasks)], user, { now, query: 'needle' });
  assert.equal(result.summary.todo, 205);
  assert.deepEqual(result.sectionMeta.todo, { total: 205, hasMore: true });
  assert.equal(result.search.total, 205); assert.equal(result.search.hasMore, true);
  assert.equal(result.search.tasks.length, 200); assert.equal(result.sections.todo.length, 200);
  assert.deepEqual(result.search.tasks.map(row => row.id), [...result.search.tasks.map(row => row.id)].sort());
  const unbound = dashboardSummary({ membership: () => null }, [state('a', tasks)], user, { now });
  assert.deepEqual(unbound.summary, { todo: 0, toReview: 0, blocked: 0, dueSoon: 0 });
  assert.deepEqual(unbound.search, { query: '', tasks: [], total: 0, hasMore: false });
  assert.throws(() => dashboardSummary(identity, [], user, { query: 'x'.repeat(121) }), error => error.status === 400);
});
