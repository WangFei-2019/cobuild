import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const statuses = new Set(['todo', 'doing', 'blocked', 'review', 'done']);
const priorities = new Set(['high', 'medium', 'low']);
const now = () => new Date().toISOString();
const id = prefix => `${prefix}-${randomUUID().slice(0, 12)}`;

function required(value, label, max = 500) {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(`请填写${label}`);
  if (value.length > max) throw new AppError(`${label}不能超过 ${max} 字`);
  return value.trim();
}
function optional(value, max = 3000) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new AppError('文本格式或长度不正确');
  return value.trim();
}
function date(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError('日期格式应为 YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new AppError('请选择有效日期');
  return value;
}
function member(state, memberId) {
  const value = state.members.find(m => m.id === memberId);
  if (!value) throw new AppError('请选择有效团队成员', 403);
  return value;
}
function task(state, taskId) {
  const value = state.tasks.find(t => t.id === taskId);
  if (!value) throw new AppError('没有找到这项任务', 404);
  return value;
}
function mayEdit(taskValue, actorId, manageProject) {
  if (taskValue.ownerId !== actorId && !manageProject) throw new AppError('请由任务负责人或项目管理者更新任务', 403);
}

export function canManageProject(state, actorId) {
  const actor = member(state, actorId);
  return Object.hasOwn(actor, 'accessRole') ? actor.accessRole === 'admin' : actorId === 'm0';
}

function milestone(state, value, due = '') {
  if (value == null || value === '') return '';
  const item = typeof value === 'string' && state.milestones?.find(item => item.id === value);
  if (!item) throw new AppError('请选择本项目有效的里程碑');
  if (due && item.due && due > item.due) throw new AppError('任务截止日期不能晚于所属里程碑');
  return value;
}
function dependencies(state, taskId, values) {
  if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) throw new AppError('任务依赖格式不正确');
  const result = [...new Set(values)];
  result.forEach(v => { task(state, v); if (v === taskId) throw new AppError('任务不能依赖自己'); });
  const reaches = (from, seen = new Set()) => {
    if (from === taskId) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return task(state, from).dependsOn.some(next => reaches(next, seen));
  };
  if (result.some(v => reaches(v))) throw new AppError('这会形成循环依赖，请调整任务顺序');
  return result;
}
function checkTaskDates(state, candidate, { checkDate = false, newDependencies = [] } = {}) {
  const dependents = state.tasks.filter(value => value.id !== candidate.id && value.dependsOn.includes(candidate.id));
  if (checkDate) {
    if (candidate.due && state.project.deadline && candidate.due > state.project.deadline) throw new AppError('任务截止日期不能晚于项目截止日期');
    if (!candidate.due && (candidate.dependsOn.length || dependents.length || state.milestones?.some(value => value.id === candidate.milestoneId && value.due))) throw new AppError('关联依赖或里程碑的任务需要明确截止日期');
    for (const predecessorId of candidate.dependsOn) {
      const predecessor = task(state, predecessorId);
      if (candidate.due && predecessor.due && predecessor.due > candidate.due) throw new AppError('任务截止日期不能早于前置任务');
    }
    if (candidate.due && dependents.some(value => value.due && candidate.due > value.due)) throw new AppError('任务截止日期不能晚于依赖它的后置任务');
  }
  for (const predecessorId of newDependencies) {
    const predecessor = task(state, predecessorId);
    if (!candidate.due || !predecessor.due) throw new AppError('建立依赖前，请为相关任务填写截止日期');
    if (predecessor.due > candidate.due) throw new AppError('任务截止日期不能早于前置任务');
  }
}
function activity(state, actorId, taskId, kind, text) {
  state.activities.unshift({ id: id('event'), actorId, taskId: taskId || '', kind, text, createdAt: now() });
}
function move(t, status, blocker = '') {
  if (!statuses.has(status)) throw new AppError('不支持的任务状态');
  if (status === 'done') throw new AppError('完成任务需要接收人确认交接');
  if (status === 'review' && !t.artifacts.length) throw new AppError('请先提交交付物，再进入待交接');
  if (status === 'review' && t.needsResubmission) throw new AppError('交付约定已变化，请重新提交对应成果');
  if (status === 'blocked' && !blocker.trim()) throw new AppError('请简单说明受阻原因');
  t.status = status;
  t.blocker = status === 'blocked' ? required(blocker, '受阻原因', 1000) : '';
  if (status !== 'review') t.acceptedAt = '';
}

export function seedState() {
  const time = '2026-10-20T10:00:00.000Z';
  const base = { artifacts: [], blocker: '', updatedAt: time, acceptedAt: '', tags: [] };
  return {
    schemaVersion: 1, revision: 1,
    project: { id: 'p1', name: '共建助手 · 第一版', description: '把分工说清楚，让进展接得上。', goal: '四个人用一周完成一版可体验的协作工具，并一起验证进展整理与成果交接。', deadline: '2026-10-27', stage: '原型验证' },
    members: [
      { id: 'm0', name: '陈知', role: '项目发起人', color: '#427b68', initial: '知' },
      { id: 'm1', name: '林夏', role: '产品与设计', color: '#b47e59', initial: '夏' },
      { id: 'm2', name: '周予', role: '数据与接口', color: '#7770a3', initial: '予' },
      { id: 'm3', name: '许言', role: '前端开发', color: '#6387a2', initial: '言' }
    ],
    tasks: [
      { ...structuredClone(base), id: 't1', code: 'CB-101', title: '确认首版范围与页面原型', description: '明确小团队的共建流程，交付总览、任务详情与交接页原型。', ownerId: 'm1', reviewerId: 'm0', due: '2026-10-21', status: 'done', priority: 'high', dependsOn: [], deliverable: '一份页面原型与明确的首版范围说明', tags: ['产品设计'], artifacts: [{ id: 'a1', name: '首版范围与原型说明.md', url: '/samples/brief.md', note: '示例资料：页面结构与首版范围已整理。', createdAt: time }], acceptedAt: time },
      { ...structuredClone(base), id: 't2', code: 'CB-102', title: '定义任务接口与示例数据', description: '约定任务、成员、进展及交付物字段，给前端一份可以直接对接的样例。', ownerId: 'm2', reviewerId: 'm3', due: '2026-10-22', status: 'doing', priority: 'high', dependsOn: ['t1'], deliverable: '接口说明 Markdown + 示例 JSON 数据', tags: ['接口', '关键依赖'] },
      { ...structuredClone(base), id: 't3', code: 'CB-103', title: '完成任务看板与详情交互', description: '做出可筛选的任务看板，支持成员更新进展、提交成果。', ownerId: 'm3', reviewerId: 'm1', due: '2026-10-24', status: 'blocked', priority: 'high', dependsOn: ['t2'], deliverable: '可访问的演示链接与操作说明', blocker: '等待接口字段确认后完成联调', tags: ['前端开发'] },
      { ...structuredClone(base), id: 't4', code: 'CB-104', title: '验证一句话整理进展', description: '用完成、部分完成、等待依赖等真实表达，检查整理后的状态是否准确。', ownerId: 'm0', reviewerId: 'm2', due: '2026-10-24', status: 'doing', priority: 'medium', dependsOn: ['t1'], deliverable: '至少五条输入与预期结果对照', tags: ['核心体验'] },
      { ...structuredClone(base), id: 't5', code: 'CB-105', title: '准备演示录屏与讲解稿', description: '串起发起人、任务负责人、接收人三个视角，演示一项成果如何交接。', ownerId: 'm1', reviewerId: 'm0', due: '2026-10-26', status: 'todo', priority: 'medium', dependsOn: ['t3', 't4'], deliverable: '两分钟演示视频与配套讲解稿', tags: ['项目交付'] },
      { ...structuredClone(base), id: 't6', code: 'CB-106', title: '整理首轮体验问题清单', description: '记录试用流程中难以理解或需要反复确认的地方，交给发起人核对。', ownerId: 'm2', reviewerId: 'm0', due: '2026-10-25', status: 'review', priority: 'low', dependsOn: ['t1'], deliverable: '包含问题、复现方式与建议的问题清单', tags: ['体验反馈'], artifacts: [{ id: 'a2', name: '首轮体验问题清单.md', url: '/samples/feedback.md', note: '示例资料：三条体验问题，等待陈知确认交接。', createdAt: time }] }
    ],
    activities: [
      { id: 'e3', kind: 'artifact', actorId: 'm2', taskId: 't6', text: '提交了「首轮体验问题清单.md」，等待陈知接收。', createdAt: '2026-10-20T10:00:00.000Z' },
      { id: 'e2', kind: 'update', actorId: 'm3', taskId: 't3', text: '看板布局已经完成，接口字段还没确认，先等周予的样例数据再联调。', createdAt: '2026-10-20T09:30:00.000Z' },
      { id: 'e1', kind: 'accept', actorId: 'm0', taskId: 't1', text: '确认接收页面原型与首版范围说明。', createdAt: '2026-10-20T08:00:00.000Z' }
    ],
    decisions: [
      { id: 'd1', title: '先服务已有的小团队', detail: '首版围绕任务分工、成员进展和成果交接验证使用价值。', createdAt: time },
      { id: 'd2', title: '完成报告与交接确认分别记录', detail: '负责人提交成果后进入待交接，由约定接收人确认完成。', createdAt: time }
    ]
  };
}

export function analyzeUpdate(state, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('请求格式不正确');
  member(state, input.actorId);
  const t = task(state, input.taskId);
  const text = required(input.text, '进展内容', 6000);
  const clauses = text.split(/[，。；！!?？\n]/).map(s => s.trim()).filter(Boolean);
  const clearedClause = s => /(不再|没有|未出现|无)(受阻|阻塞)|(?:受阻|阻塞|等待)(?:状态)?(?:已经|已)?(?:解除|解决|结束)|不(?:需要|用|必)(?:再)?等|不用等|无需等待/.test(s);
  const unblocked = clauses.some(s => clearedClause(s) || /(?:已经|已)(解除|解决)|可以继续/.test(s));
  const blockedClause = clauses.find(s => !clearedClause(s) && /(卡在|受阻|阻塞|等(?:待|着)?[^，。；\n]{1,40}|缺少|没拿到|无法继续|还没[^，。；\n]{0,15}(确认|提供|拿到|给))/.test(s));
  const blocked = Boolean(blockedClause);
  const negativeCompletion = /(没|未|尚未|还没|没有)[^，。；\n]{0,5}(完成|做完|做好|交付|搞定|验收)|完成(?:了)?\s*[1-9]\d?\s*[%％]/.test(text);
  const complete = !negativeCompletion && /(已完成|完成了|做好了|做完了|搞定了|全部完成|开发完成|已交付|可以验收|提交验收|完成\s*100\s*[%％])/.test(text);
  let status = null;
  let blocker = '';
  const missing = [], rationale = [];
  if (blocked) {
    status = 'blocked';
    blocker = blockedClause;
    rationale.push('原文包含等待或阻塞的表达，建议标记为受阻。');
  } else if (complete) {
    if (t.artifacts.length) { status = 'review'; rationale.push('原文报告完成，已有交付物，建议交给接收人检查。'); }
    else { status = 'doing'; missing.push(`尚未提交约定交付物：${t.deliverable || '成果链接、文件或文字说明'}`); rationale.push('报告完成与成果交接是两件事，先保留为进行中。'); }
  } else if (unblocked || /(进行中|开始|继续|实现了|还在|完成(?:了)?\s*[1-9]\d?\s*[%％]|做了一部分)/.test(text)) {
    status = 'doing'; rationale.push('原文描述正在推进或阻塞解除，建议标记为进行中。');
  } else rationale.push('没有识别到明确的状态变化，保存原文并保留当前状态。');
  if (t.status === 'done') { status = null; rationale.push('任务已经确认交接，新增说明不会自动重开任务。'); }
  const affectedTaskIds = state.tasks.filter(v => v.dependsOn.includes(t.id) && v.status !== 'done').map(v => v.id);
  return { mode: 'local-rules', summary: text.length > 120 ? `${text.slice(0, 120)}…` : text, status, blocker, missing, affectedTaskIds, rationale, sourceText: text, taskUpdatedAt: t.updatedAt };
}

export function applyAction(current, input, permissions = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('请求格式不正确');
  const state = structuredClone(current);
  member(state, input.actorId);
  const manageProject = permissions.manageProject === undefined ? canManageProject(state, input.actorId) : permissions.manageProject === true;
  if (input.expectedRevision != null && input.expectedRevision !== state.revision) throw new AppError('其他成员刚刚更新了项目，请刷新后再试', 409);
  let t;
  if (['updateTask', 'setStatus', 'addUpdate', 'submitArtifact', 'accept', 'requestChanges'].includes(input.type)) {
    t = task(state, input.taskId);
    if (input.taskUpdatedAt && input.taskUpdatedAt !== t.updatedAt) throw new AppError('任务已有更新，请核对最新内容后重新操作', 409);
    if (!['accept', 'requestChanges'].includes(input.type)) mayEdit(t, input.actorId, manageProject);
  }
  switch (input.type) {
    case 'createTask': {
      if (state.tasks.length >= 500) throw new AppError('体验版最多支持 500 项任务');
      member(state, input.ownerId); member(state, input.reviewerId);
      const taskId = id('task');
      const code = `CB-${Math.max(100, ...state.tasks.map(v => Number(v.code.split('-')[1]) || 100)) + 1}`;
      if (!priorities.has(input.priority || 'medium')) throw new AppError('优先级不正确');
      const due = date(input.due);
      const created = { id: taskId, code, title: required(input.title, '任务名称', 180), description: optional(input.description), ownerId: input.ownerId, reviewerId: input.reviewerId, due, status: 'todo', priority: input.priority || 'medium', tags: [], dependsOn: dependencies(state, taskId, input.dependsOn || []), milestoneId: milestone(state, input.milestoneId, due), deliverable: required(input.deliverable, '交付约定', 1000), artifacts: [], blocker: '', updatedAt: now(), acceptedAt: '' };
      checkTaskDates(state, created, { checkDate: true, newDependencies: created.dependsOn });
      state.tasks.push(created); activity(state, input.actorId, taskId, 'create', `创建任务「${created.title}」，由${member(state, created.ownerId).name}负责。`); break;
    }
    case 'updateTask': {
      const p = input.patch;
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new AppError('请提供需要修改的字段');
      const allowed = ['title', 'description', 'ownerId', 'reviewerId', 'due', 'priority', 'deliverable', 'dependsOn', 'milestoneId'];
      if (Object.keys(p).some(k => !allowed.includes(k))) throw new AppError('包含不支持修改的任务字段');
      const previousDeliverable = t.deliverable, previousReviewer = t.reviewerId, previousDue = t.due,
        previousDependencies = [...t.dependsOn], previousMilestoneId = t.milestoneId || '';
      if ('title' in p) t.title = required(p.title, '任务名称', 180);
      if ('description' in p) t.description = optional(p.description);
      if ('ownerId' in p) { member(state, p.ownerId); t.ownerId = p.ownerId; }
      if ('reviewerId' in p) { member(state, p.reviewerId); t.reviewerId = p.reviewerId; }
      if ('due' in p) t.due = date(p.due);
      if ('priority' in p) { if (!priorities.has(p.priority)) throw new AppError('优先级不正确'); t.priority = p.priority; }
      if ('deliverable' in p) t.deliverable = required(p.deliverable, '交付约定', 1000);
      if ('dependsOn' in p) t.dependsOn = dependencies(state, t.id, p.dependsOn);
      if ('milestoneId' in p) t.milestoneId = milestone(state, p.milestoneId);
      const dateChanged = previousDue !== t.due, milestoneChanged = previousMilestoneId !== (t.milestoneId || '');
      if (dateChanged || milestoneChanged) milestone(state, t.milestoneId, t.due);
      checkTaskDates(state, t, { checkDate: dateChanged || milestoneChanged,
        newDependencies: t.dependsOn.filter(value => !previousDependencies.includes(value)) });
      let consequence = '';
      if (t.deliverable !== previousDeliverable && t.artifacts.length) {
        t.status = 'doing'; t.blocker = ''; t.acceptedAt = ''; t.needsResubmission = true;
        consequence = '交付约定已变化，需要重新提交对应成果。';
      } else if (t.reviewerId !== previousReviewer && t.status === 'done') {
        t.status = 'review'; t.acceptedAt = ''; consequence = '接收人已变化，需要重新确认交接。';
      }
      activity(state, input.actorId, t.id, 'change', `更新了任务「${t.title}」的约定。${consequence}`); break;
    }
    case 'setStatus': {
      move(t, input.status, optional(input.blocker, 1000));
      activity(state, input.actorId, t.id, 'status', `更新任务状态为${({todo:'待开始',doing:'进行中',blocked:'受阻',review:'待交接'})[t.status]}${t.blocker ? `：${t.blocker}` : '。'}`); break;
    }
    case 'addUpdate': {
      const text = required(input.text, '进展内容', 6000);
      if (input.status) move(t, input.status, optional(input.blocker, 1000));
      activity(state, input.actorId, t.id, 'update', text); break;
    }
    case 'submitArtifact': {
      const name = required(input.name, '成果名称', 200);
      let url = optional(input.url, 2000), note = optional(input.note, 6000);
      if (url && !/^https?:\/\//i.test(url) && !/^\/api\/files\/[a-f0-9-]+$/.test(url)) throw new AppError('成果链接只支持 http 或 https');
      if (/^https?:/i.test(url)) { try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); } catch { throw new AppError('请填写有效的成果链接'); } }
      if (!url && !note) throw new AppError('请提供成果文件、链接或文字说明');
      t.artifacts.unshift({ id: id('artifact'), name, url, note, createdAt: now(), submittedBy: input.actorId, ...(input.fileMeta ? {fileName: input.fileMeta.name, fileSize: input.fileMeta.size} : {}) });
      t.needsResubmission = false;
      move(t, 'review'); t.acceptedAt = '';
      activity(state, input.actorId, t.id, 'artifact', `提交了「${name}」，等待${member(state, t.reviewerId).name}确认交接。`); break;
    }
    case 'accept': {
      if (t.reviewerId !== input.actorId) throw new AppError('只有约定接收人可以确认交接', 403);
      if (t.status !== 'review' || !t.artifacts.length) throw new AppError('这项任务尚未提交可接收的成果', 409);
      t.status = 'done'; t.blocker = ''; t.acceptedAt = now();
      activity(state, input.actorId, t.id, 'accept', '已检查交付物，确认接收。这项任务已完成。'); break;
    }
    case 'requestChanges': {
      if (t.reviewerId !== input.actorId) throw new AppError('只有约定接收人可以退回修改', 403);
      if (t.status !== 'review') throw new AppError('这项任务当前不在待交接状态', 409);
      const reason = required(input.reason, '修改意见', 2000);
      t.status = 'doing'; t.blocker = ''; t.acceptedAt = '';
      activity(state, input.actorId, t.id, 'changes', `请继续修改：${reason}`); break;
    }
    case 'addMember': {
      if (!manageProject) throw new AppError('请由项目发起人或管理者添加成员', 403);
      if (state.members.length >= 32) throw new AppError('体验版最多支持 32 名成员');
      const name = required(input.name, '成员姓名', 40);
      if (!permissions.allowDuplicateNames && state.members.some(m => m.name === name)) throw new AppError('已存在同名成员，请增加区分信息');
      state.members.push({ id: id('member'), name, role: optional(input.role, 80) || '项目协作者', initial: [...name].at(-1), color: ['#427b68', '#b47e59', '#7770a3', '#6387a2'][state.members.length % 4] });
      activity(state, input.actorId, '', 'member', `添加团队成员${name}。`); break;
    }
    case 'updateProject': {
      if (!manageProject) throw new AppError('请由项目发起人或管理者修改项目约定', 403);
      const p = input.patch;
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new AppError('请提供需要修改的项目信息');
      if (Object.keys(p).some(k => !['name', 'description', 'goal', 'deadline'].includes(k))) throw new AppError('包含不支持修改的项目字段');
      if ('name' in p) state.project.name = required(p.name, '项目名称', 100);
      if ('description' in p) state.project.description = optional(p.description, 500);
      if ('goal' in p) state.project.goal = optional(p.goal, 1500);
      if ('deadline' in p) {
        const deadline = date(p.deadline);
        if (deadline && deadline !== state.project.deadline && (state.tasks.some(value => value.due && value.due > deadline)
          || state.milestones?.some(value => value.due && value.due > deadline))) throw new AppError('项目截止日期不能早于现有任务或里程碑，请先调整相关计划');
        state.project.deadline = deadline;
      }
      activity(state, input.actorId, '', 'decision', '更新了项目目标或交付约定。'); break;
    }
    default: throw new AppError('不支持的操作');
  }
  if (t) {
    const previous = Date.parse(t.updatedAt);
    t.updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
  }
  state.revision += 1;
  return state;
}

export function projectReport(state) {
  const label = {todo:'待开始',doing:'进行中',blocked:'受阻',review:'待交接',done:'已完成'};
  const name = memberId => state.members.find(m => m.id === memberId)?.name || '未分配';
  const clean = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const tasks = state.tasks || [], milestones = state.milestones || [];
  const taskName = taskId => { const value = tasks.find(item => item.id === taskId); return value ? `${value.code} ${value.title}` : '未找到关联任务'; };
  const milestoneName = milestoneId => milestones.find(item => item.id === milestoneId)?.title || '未关联';
  const count = status => tasks.filter(item => item.status === status).length;
  const lines = [`# ${clean(state.project.name)}`, '', clean(state.project.description), '', '## 项目目标与概况', '', clean(state.project.goal) || '目标待补充', '', `截止日期：${clean(state.project.deadline) || '未指定'}`, `数据版本：${state.revision}`, '', `任务 ${tasks.length} 项：待开始 ${count('todo')}，进行中 ${count('doing')}，受阻 ${count('blocked')}，待交接 ${count('review')}，已完成 ${count('done')}。`, `里程碑 ${milestones.length} 个，其中已验收 ${milestones.filter(item => item.status === 'accepted' && item.acceptedAt).length} 个。`, '', '## 里程碑与验收', ''];
  if (!milestones.length) lines.push('尚未制定里程碑。');
  for (const milestone of milestones) {
    const related = tasks.filter(item => item.milestoneId === milestone.id);
    const accepted = milestone.status === 'accepted' && milestone.acceptedAt;
    lines.push(`### ${clean(milestone.title)}`, '', `状态：${accepted ? '已验收' : '推进中'}；计划日期：${clean(milestone.due) || '未指定'}；已交接任务：${related.filter(item => item.status === 'done' && item.acceptedAt).length}/${related.length}。`, '', `阶段目标：${clean(milestone.goal)}`, '', `验收标准：${clean(milestone.acceptanceCriteria)}`, '', `关联任务：${related.map(item => clean(`${item.code} ${item.title}`)).join('；') || '尚未关联任务'}`);
    if (accepted) lines.push('', `验收人：${clean(name(milestone.acceptedBy))}；验收时间：${clean(milestone.acceptedAt)}`, '', `验收说明：${clean(milestone.acceptanceNote) || '未附说明'}`);
    if (milestone.acceptanceHistory?.length) lines.push('', `保留历史验收记录 ${milestone.acceptanceHistory.length} 条；当前验收状态以上述记录为准。`);
    lines.push('');
  }
  lines.push('## 任务与交接', '', '| 任务 | 负责人 | 接收人 | 状态 | 截止日期 | 前置任务 | 里程碑 | 交付约定 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  tasks.forEach(t => lines.push(`| ${clean(t.code)} ${clean(t.title)} | ${clean(name(t.ownerId))} | ${clean(name(t.reviewerId))} | ${label[t.status] || '未知'} | ${clean(t.due) || '未指定'} | ${(t.dependsOn || []).map(value => clean(taskName(value))).join('；') || '无'} | ${clean(milestoneName(t.milestoneId))} | ${clean(t.deliverable)} |`));
  if (!tasks.length) lines.push('', '暂无任务，尚无可计算的完成进度。');
  lines.push('', '## 当前受阻', '');
  const blocked = tasks.filter(t => t.status === 'blocked');
  blocked.forEach(t => lines.push(`- ${clean(t.code)} ${clean(t.title)}：${clean(t.blocker)}`));
  if (!blocked.length) lines.push('暂无已报告的阻塞。');
  lines.push('', '## 成果记录', '');
  let artifactCount = 0;
  tasks.forEach(t => (t.artifacts || []).forEach((a, index) => {
    artifactCount++;
    const accepted = index === 0 && t.status === 'done' && t.acceptedAt;
    const status = accepted ? `最新成果已接收，${name(t.reviewerId)}，${t.acceptedAt}` : index > 0 ? '历史提交版本' : t.status === 'review' ? '最新成果待接收' : '尚未确认当前约定';
    lines.push(`- ${clean(t.code)} ${clean(a.name)}（${clean(status)}）${a.url ? `；引用：${clean(a.url)}` : ''}${a.note ? `；说明：${clean(a.note)}` : ''}`);
  }));
  if (!artifactCount) lines.push('暂无提交成果。');
  else lines.push('', '文件地址是协作服务中的引用。本报告不包含上传文件本身，也不能代替完整数据备份。');
  lines.push('', '## 最近动态', '');
  (state.activities || []).slice(0, 20).forEach(a => lines.push(`- ${clean(a.createdAt)} ${clean(name(a.actorId))}：${clean(a.text)}`));
  lines.push('', '> 进展整理使用本地规则；成果交接由指定接收人确认。AI 规划是否可用取决于工作区模型配置。');
  return lines.join('\n');
}
