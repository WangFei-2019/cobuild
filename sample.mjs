import { AppError, applyAction } from './domain.mjs';
import { applyMilestoneAction } from './planning.mjs';

export const SAMPLE_VERSION = 1;
const KIND = 'cobuild-sample';
export function isSampleState(state) {
  return state?.sample?.kind === KIND && state.sample.version === SAMPLE_VERSION
    && typeof state.sample.ownerAccountId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(state.sample.ownerAccountId);
}
export const sampleOwner = state => isSampleState(state) ? state.sample.ownerAccountId : null;
export const sampleInfo = (state, accountId) => isSampleState(state) ? { version: SAMPLE_VERSION, canArchive: sampleOwner(state) === accountId } : null;
export function markSampleState(state, ownerAccountId) {
  const next = structuredClone(state);
  next.sample = { kind: KIND, version: SAMPLE_VERSION, ownerAccountId };
  if (!isSampleState(next)) throw new AppError('示例创建账号不正确');
  return next;
}
export function sampleProjectInput(ownerName) {
  return { name: '协作流程示例', description: '用于体验任务、成果交接与里程碑；虚拟伙伴没有账号。真实协作请创建自己的项目。',
    goal: '亲手推进一条任务，接收示例伙伴的成果，并核对里程碑。', ownerName, ownerRole: '体验发起人', color: '#527ea5',
    members: [{ name: '示例·协作伙伴', role: '用于演示交接的虚拟分工，无真实账号' }] };
}
export function buildSampleState(baseState, { today } = {}) {
  if (!today) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]));
    today = `${parts.year}-${parts.month}-${parts.day}`;
  }
  const date = new Date(`${today}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== today) throw new AppError('示例日期不正确');
  if (baseState.members?.length !== 2 || !baseState.members.some(member => member.id === 'm0') || !baseState.members.some(member => member.id === 'm1') || baseState.tasks?.length) throw new AppError('示例需要空项目、本人和一位固定虚拟伙伴');
  let state = structuredClone(baseState);
  const shifted = days => { const at = new Date(`${today}T00:00:00Z`); at.setUTCDate(at.getUTCDate() + days); return at.toISOString().slice(0, 10); };
  state.project.deadline = shifted(7); state.project.stage = '示例体验';
  state.members.find(member => member.id === 'm1').virtual = true;
  const milestone = (title, goal, due, acceptanceCriteria) => {
    state = applyMilestoneAction(state, { type: 'createMilestone', actorId: 'm0', expectedRevision: state.revision, title, goal, due, acceptanceCriteria });
    return state.milestones.at(-1).id;
  };
  const task = (title, description, due, milestoneId, ownerId = 'm0', dependsOn = []) => {
    state = applyAction(state, { type: 'createTask', actorId: 'm0', title, description, ownerId, reviewerId: 'm0', due, milestoneId, dependsOn, deliverable: '一份可核对的文字说明，包含本任务的处理结果和检查方式。' });
    return state.tasks.at(-1).id;
  };
  const foundation = milestone('示例：已完成的成果交接', '查看任务确认与里程碑验收的区别', shifted(0), '关联任务已有成果，且由指定接收人确认交接。');
  const finished = task('示例：看看一份已确认的成果', '这条任务和阶段均为内置示例，展示可追溯的交接记录。', shifted(-1), foundation);
  state = applyAction(state, { type: 'submitArtifact', actorId: 'm0', taskId: finished, name: '示例·范围确认说明', note: '内置示例成果：明确谁负责、交付什么、由谁接收。此记录不代表真实项目已经交付。' });
  state = applyAction(state, { type: 'accept', actorId: 'm0', taskId: finished });
  state = applyMilestoneAction(state, { type: 'acceptMilestone', actorId: 'm0', expectedRevision: state.revision, milestoneId: foundation, note: '内置示例：已核对关联任务及成果交接。' });
  const practice = milestone('示例：亲手完成一次协作', '体验推进、处理受阻与接收成果', shifted(5), '本阶段三条任务均提交成果，并由本人确认接收；请先核对再验收。');
  task('示例：从这条本人待办开始', '先切换为进行中，再提交一段文字成果。你也是接收人，可以完整体验交接。', shifted(3), practice, 'm0', [finished]);
  const handoff = task('示例：接收伙伴提交的成果', '这是虚拟伙伴的内置成果；打开任务核对后，由你确认接收或提出修改意见。', shifted(1), practice, 'm1');
  state = applyAction(state, { type: 'submitArtifact', actorId: 'm1', taskId: handoff, name: '示例·待核对的交付清单', note: '内置示例清单：任务有明确交付物和接收人；未完成事项单独说明。请体验确认接收或退回修改。' });
  const blocked = task('示例：处理一条受阻事项', '补充解除阻碍的说明，再继续推进。所有内容仅供练习。', shifted(4), practice);
  state = applyAction(state, { type: 'setStatus', actorId: 'm0', taskId: blocked, status: 'blocked', blocker: '示例：交付约定还需要补充一个检查步骤。' });
  return state;
}
