import test from 'node:test';
import assert from 'node:assert/strict';
import {seedState, projectReport} from '../domain.mjs';

test('项目报告包含阶段验收、日期和可读依赖，并保持源数据不变', () => {
  const state = seedState();
  state.project.description = '团队共同交付的背景';
  state.milestones = [{id:'report-phase',title:'可交付阶段',goal:'可体验并验收',due:'2026-10-25',acceptanceCriteria:'完成关联任务并检查成果',status:'accepted',acceptedAt:'2026-10-24T08:00:00Z',acceptedBy:'m0',acceptanceNote:'已完成核对',acceptanceHistory:[]}];
  state.tasks[0].milestoneId = 'report-phase';
  const before = structuredClone(state);
  const report = projectReport(state);
  assert.ok(report.includes('团队共同交付的背景'));
  assert.ok(report.includes('## 里程碑与验收'));
  assert.ok(report.includes('### 可交付阶段'));
  assert.ok(report.includes('验收标准：完成关联任务并检查成果'));
  assert.ok(report.includes('验收人：陈知；验收时间：2026-10-24T08:00:00Z'));
  assert.ok(report.includes('验收说明：已完成核对'));
  assert.ok(report.includes('| 截止日期 | 前置任务 | 里程碑 |'));
  assert.ok(report.includes(state.tasks[0].due));
  assert.ok(report.includes(state.tasks[0].code + ' ' + state.tasks[0].title));
  assert.ok(!report.includes('report-phase'));
  assert.deepEqual(state, before);
});

test('报告区分最新已接收成果和历史版本，空项目不伪造完成进度', () => {
  const state = seedState(), task = state.tasks[0];
  task.status = 'done'; task.acceptedAt = '2026-10-24T08:00:00Z';
  task.artifacts = [{id:'new',name:'新成果',note:'人工检查过'},{id:'old',name:'旧成果',note:'后来重新交付'}];
  const report = projectReport(state);
  assert.match(report, /新成果（最新成果已接收/);
  assert.match(report, /旧成果（历史提交版本）/);
  assert.equal((report.match(/最新成果已接收/g) || []).length, state.tasks.filter(item => item.status === 'done' && item.acceptedAt && item.artifacts?.length).length);
  const empty = projectReport({...state, tasks:[], milestones:[], activities:[]});
  assert.ok(empty.includes('暂无任务，尚无可计算的完成进度。'));
  assert.ok(empty.includes('尚未制定里程碑。'));
  assert.ok(empty.includes('暂无提交成果。'));
  assert.ok(!empty.includes('100%'));
});

test('报告保留表格列结构，文本中的HTML不作为原始标签输出', () => {
  const state = seedState();
  state.tasks[0].title = '第一列 | 第二列\n<script>text</script>';
  const report = projectReport(state);
  assert.ok(report.includes('第一列 \\| 第二列 &lt;script&gt;text&lt;/script&gt;'));
  assert.ok(!report.includes('<script>'));
});
