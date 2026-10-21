import seed from '../demo/seed.json' with { type: 'json' };
import { randomUUID } from 'node:crypto';
import { AppError, applyAction, analyzeUpdate, projectReport } from '../domain.mjs';
import { applyPlanDraft, validatePlanDraft, applyMilestoneAction, reconcileMilestones, previewReplan, applyReplanDraft } from '../planning.mjs';
import { dashboardSummary } from '../dashboard.mjs';
import { peopleSummary, personDetails } from '../people.mjs';

export const DEMO_STORAGE_KEY = 'cobuild.pages.demo.v1';
export const DEMO_MODEL = '内置示例 · 非AI生成';
const FILE_LIMIT = 500 * 1024, FILES_LIMIT = 1024 * 1024;
const clone = value => structuredClone(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => { const error = new AppError('静态演示不提供真实账号、邀请或多人同步，请使用服务端版本。', 501); error.code = 'DEMO_UNAVAILABLE'; throw error; };
function text(value, label, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new AppError(`${label}格式不正确`);
  return value.trim();
}
function date(value, label = '截止日期') {
  const result = text(value, label, 10); if (!result) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(`${result}T00:00:00Z`)) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) throw new AppError(`${label}不正确`);
  return result;
}
function dataShape(value) {
  return record(value) && value.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.revision > 0
    && Array.isArray(value.projects) && value.projects.length > 0 && Array.isArray(value.people) && record(value.bindings) && record(value.files)
    && value.projects.every(state => state?.schemaVersion === 1 && state.project?.id && Number.isSafeInteger(state.revision)
      && ['members', 'tasks', 'activities', 'decisions'].every(key => Array.isArray(state[key])))
    && value.projects.some(state => state.project.id === value.defaultProjectId)
    && value.people.some(person => person.id === value.currentPersonId);
}

/** Explicit, browser-only demo repository. Never called as a server/network fallback. */
export function createDemoAPI({ storage = globalThis.localStorage, key = DEMO_STORAGE_KEY, now = () => new Date() } = {}) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new AppError('浏览器本地存储不可用，无法保存演示修改。', 507);
  function persist(value) {
    try { storage.setItem(key, JSON.stringify(value)); }
    catch { throw new AppError('浏览器本地存储空间不足或被禁用。原有演示数据已保留，请减少附件或在设置中重置本地演示。', 507); }
  }
  function fresh() {
    const doc = clone(seed), at = now(), dayParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    const parts = Object.fromEntries(dayParts.map(part => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const shifted = offset => { const value = new Date(`${today}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + offset); return value.toISOString().slice(0, 10); };
    for (const state of doc.projects) {
      const offsets = doc.dateOffsets[state.project.id]; state.project.deadline = shifted(offsets.deadline);
      state.project.createdAt = new Date(at.getTime() - 3 * 86400000).toISOString();
      for (const task of state.tasks) {
        task.due = shifted(offsets.tasks[task.id]); task.updatedAt = new Date(at.getTime() - 2 * 86400000).toISOString();
        if (task.acceptedAt) task.acceptedAt = new Date(at.getTime() - 86400000).toISOString();
        for (const artifact of task.artifacts) artifact.createdAt = task.updatedAt;
      }
      for (const milestone of state.milestones) { milestone.due = shifted(offsets.milestones[milestone.id]); milestone.createdAt = state.project.createdAt; milestone.updatedAt = state.project.createdAt; }
      state.activities.forEach((item, index) => { item.createdAt = new Date(at.getTime() - (index + 1) * 1800000).toISOString(); });
    }
    // Build a real acceptance fingerprint through the shared domain, so later
    // edits invalidate this synthetic example exactly as they do on the server.
    const first = doc.projects[0], actorId = identity(doc).membership(first.project.id, doc.currentPersonId).memberId;
    doc.projects[0] = cleanState(applyMilestoneAction(authorized(doc, first), { type: 'acceptMilestone', milestoneId: 'demo-scope',
      actorId, expectedRevision: first.revision, note: '内置示例：首版范围成果已逐项核对。' }));
    return doc;
  }
  function load() {
    let source;
    try { source = storage.getItem(key); }
    catch { throw new AppError('无法读取浏览器本地演示数据，请检查存储权限。', 507); }
    if (source === null) { const value = fresh(); persist(value); return value; }
    let value; try { value = JSON.parse(source); } catch { /* Preserve corrupt storage for an explicit reset. */ }
    if (!dataShape(value)) throw new AppError('本地演示数据无法读取。请先导出保留的数据，或在设置中确认重置本地演示。', 500);
    return value;
  }
  function identity(doc) {
    const person = personId => { const value = doc.people.find(item => item.id === personId); if (!value) throw new AppError('没有找到这个演示成员档案', 404); return clone(value); };
    const member = (projectId, memberId) => {
      const binding = doc.bindings[projectId]?.[memberId];
      return binding ? { ...clone(binding), projectId, memberId, accountLinked: Boolean(person(binding.personId).accountLinked) } : null;
    };
    return { person, people: () => clone(doc.people), member, membership(projectId, personId) {
      const item = Object.entries(doc.bindings[projectId] || {}).find(([, value]) => value.personId === personId);
      return item ? member(projectId, item[0]) : null;
    } };
  }
  function user(doc) {
    const person = identity(doc).person(doc.currentPersonId);
    return { id: 'demo-experience-session', name: person.name, email: 'demo@local.invalid', personId: person.id, workspaceRole: 'admin', demo: true };
  }
  const session = doc => ({ setupRequired: false, setupTokenRequired: false, demo: true, user: user(doc) });
  function stateFor(doc, projectId) {
    const id = projectId === undefined ? doc.defaultProjectId : projectId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) throw new AppError('项目标识不正确');
    const state = doc.projects.find(value => value.project.id === id);
    if (!state) throw new AppError('没有找到这个演示项目', 404);
    return state;
  }
  const permissions = { manageProject: true, createTask: true, readOnly: false };
  function decorate(doc, state) {
    const adapter = identity(doc);
    return { ...clone(state), demo: true, members: state.members.map(member => ({ ...clone(member), ...adapter.member(state.project.id, member.id) })),
      currentMemberId: adapter.membership(state.project.id, doc.currentPersonId)?.memberId || null, permissions: { ...permissions } };
  }
  function authorized(doc, state) {
    const value = decorate(doc, state);
    for (const member of value.members) if (member.id === value.currentMemberId) member.accessRole = 'admin';
    return value;
  }
  function workspace(doc) {
    return { revision: doc.revision, defaultProjectId: doc.defaultProjectId, currentPersonId: doc.currentPersonId, demo: true,
      permissions: { createProject: true, manageWorkspace: true }, projects: doc.projects.map(state => {
        const value = decorate(doc, state), p = state.project;
        return { ...clone(p), description: p.description || '', goal: p.goal || '', deadline: p.deadline || '', color: p.color || '#427b68',
          ownerName: state.members.find(member => member.id === 'm0')?.name || '', memberCount: state.members.length,
          taskCount: state.tasks.length, doneCount: state.tasks.filter(task => task.status === 'done').length,
          blockedCount: state.tasks.filter(task => task.status === 'blocked').length, reviewCount: state.tasks.filter(task => task.status === 'review').length,
          permissions: { ...permissions }, members: value.members };
      }) };
  }
  function cleanState(next) {
    const clean = clone(next); delete clean.demo; delete clean.currentMemberId; delete clean.permissions;
    clean.members = clean.members.map(member => {
      const { personId, accountLinked, accessRole, projectId, memberId, ...original } = member; return original;
    });
    return clean;
  }
  function saveState(doc, next) {
    const clean = cleanState(next);
    doc.projects[doc.projects.findIndex(state => state.project.id === clean.project.id)] = clean;
    doc.revision += 1; persist(doc); return decorate(doc, clean);
  }
  function actor(doc, state, input) {
    if ('actorId' in input) throw new AppError('演示身份由当前体验者确定，请勿冒充其他成员。', 403);
    const actorId = identity(doc).membership(state.project.id, doc.currentPersonId)?.memberId;
    if (!actorId) throw new AppError('当前体验者尚未加入该演示项目', 403);
    return { ...input, actorId };
  }
  function addPerson(doc, name, color = '#6387a2') {
    const person = { id: `person-${randomUUID()}`, name: text(name, '成员姓名', 40, true), color, initial: [...name].at(-1), bio: '本浏览器的演示成员', accountLinked: false };
    doc.people.push(person); return person;
  }
  function createProject(doc, input) {
    if (Object.keys(input).some(field => !['name', 'description', 'goal', 'deadline', 'ownerName', 'ownerRole', 'ownerPersonId', 'color', 'members'].includes(field))) throw new AppError('包含不支持的项目字段');
    if (input.members !== undefined && !Array.isArray(input.members)) throw new AppError('初始成员格式不正确');
    if ((input.members || []).length > 31) throw new AppError('每个演示项目最多支持32名成员');
    const adapter = identity(doc), owner = adapter.person(input.ownerPersonId || doc.currentPersonId), color = input.color || '#427b68';
    if (typeof color !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) throw new AppError('项目颜色需要合法的十六进制颜色');
    const createdAt = now().toISOString(), projectId = `project-${randomUUID()}`;
    const members = [{ id: 'm0', name: owner.name, role: text(input.ownerRole, '发起人职责', 80) || '项目发起人', color, initial: owner.initial }];
    const bindings = { m0: { personId: owner.id, accessRole: 'admin' } }, seen = new Set([owner.id]);
    for (const [index, value] of (input.members || []).entries()) {
      if (!record(value) || Object.keys(value).some(field => !['name', 'personId', 'role'].includes(field))) throw new AppError('初始成员格式不正确');
      const person = value.personId ? adapter.person(value.personId) : addPerson(doc, value.name);
      if (seen.has(person.id)) throw new AppError('同一人员不能重复加入项目'); seen.add(person.id);
      const id = `m${index + 1}`;
      members.push({ id, name: person.name, role: text(value.role, '成员职责', 80) || '项目协作者', color: person.color, initial: person.initial });
      bindings[id] = { personId: person.id, accessRole: 'member' };
    }
    if (!seen.has(doc.currentPersonId)) {
      if (members.length >= 32) throw new AppError('请为演示体验者保留一个成员位置');
      const person = adapter.person(doc.currentPersonId);
      members.push({ id: 'demo-self', name: person.name, role: '项目管理', color: person.color, initial: person.initial });
      bindings['demo-self'] = { personId: person.id, accessRole: 'admin' };
    }
    const actorId = Object.keys(bindings).find(id => bindings[id].personId === doc.currentPersonId);
    const state = { schemaVersion: 1, revision: 1, project: { id: projectId, name: text(input.name, '项目名称', 100, true),
      description: text(input.description, '项目简介', 500), goal: text(input.goal, '项目目标', 1500), deadline: date(input.deadline), color, stage: '项目启动', createdAt },
      members, tasks: [], decisions: [], milestones: [], activities: [{ id: `event-${randomUUID()}`, actorId, taskId: '', kind: 'create', text: '在本浏览器创建演示项目。', createdAt }] };
    doc.bindings[projectId] = bindings; doc.projects.push(state); doc.revision += 1; persist(doc);
    return { state: decorate(doc, state), workspace: workspace(doc) };
  }
  function samplePlan(doc, state, input, replan) {
    const goal = text(input.goal, '规划目标', 6000, true), ownMember = actor(doc, state, input).actorId;
    const requestedDue = date(input.deadline), deadline = [requestedDue, state.project.deadline].filter(Boolean).sort()[0] || new Date(now().getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const earlier = new Date(`${deadline}T00:00:00Z`); earlier.setUTCDate(earlier.getUTCDate() - 2);
    let draft = { title: '示例：确认范围到成果交接', summary: '这是本地固定示例，不根据自然语言智能生成；用于体验编辑、校验和确认流程。',
      assumptions: ['固定示例模板，成员与日期仅按当前项目填入；请自行核对。'], risks: ['示例不会理解项目要求，也不会调用模型。'], questions: ['请核对交付物、人员与截止日期后再确认。'],
      milestones: [{ id: 'sample-phase', title: '示例阶段：交付与核对', goal: '把待交付成果说清楚并完成一次交接', due: deadline, acceptanceCriteria: '约定成果已提交，由指定接收人确认' }],
      tasks: [{ id: 'sample-scope', title: '示例任务：整理交付清单', description: '列出本轮交付物和检查方式，替换为自己的真实内容。', ownerId: ownMember, reviewerId: ownMember, due: earlier.toISOString().slice(0, 10), deliverable: '一份列明内容与检查方式的交付清单', dependsOn: [], milestoneId: 'sample-phase' },
        { id: 'sample-handoff', title: '示例任务：提交并核对成果', description: '提供可检查的成果并确认交接。', ownerId: ownMember, reviewerId: ownMember, due: deadline, deliverable: '可打开的成果与核对记录', dependsOn: ['sample-scope'], milestoneId: 'sample-phase' }] };
    if (replan) {
      const editable = state.tasks.find(task => ['todo', 'doing', 'blocked'].includes(task.status) && !task.artifacts?.length && !task.acceptedAt);
      draft.projectGoal = text(goal, '项目目标', 1500, true);
      if (editable) {
        const hasMilestone = (state.milestones || []).some(value => value.id === editable.milestoneId);
        const due = editable.due || deadline;
        draft.milestones = hasMilestone ? [] : [{ ...draft.milestones[0], existingMilestoneId: '', due }];
        draft.tasks = [{ id: 'sample-remaining', existingTaskId: editable.id, title: editable.title, description: editable.description || '', ownerId: editable.ownerId, reviewerId: editable.reviewerId,
          due, deliverable: `${String(editable.deliverable || '交付成果').slice(0, 940)}\n示例调整：附一份检查清单。`, dependsOn: [...(editable.dependsOn || [])], milestoneId: hasMilestone ? editable.milestoneId : 'sample-phase' }];
      } else if (state.tasks.length) { draft.milestones = []; draft.tasks = []; draft.questions.push('现有任务均受保护，示例只允许调整项目目标。'); }
      else { draft.milestones = draft.milestones.map(item => ({ ...item, existingMilestoneId: '' })); draft.tasks = draft.tasks.map(item => ({ ...item, existingTaskId: '' })); }
      const preview = previewReplan(authorized(doc, state), { actorId: ownMember, expectedRevision: state.revision, draft });
      return { demo: true, samplePlanning: true, model: DEMO_MODEL, generatedAt: now().toISOString(), draft, ...preview };
    }
    draft = validatePlanDraft(state, draft);
    return { demo: true, samplePlanning: true, model: DEMO_MODEL, generatedAt: now().toISOString(), baseRevision: state.revision, draft };
  }
  function attachFile(doc, action) {
    const file = action.file;
    if (!record(file) || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 200 || !file.name.isWellFormed() || /[\u0000-\u001f\u007f]/.test(file.name)
      || typeof file.base64 !== 'string' || file.base64.length > Math.ceil(FILE_LIMIT / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new AppError('演示附件格式不正确；单个附件最多500 KiB');
    let binary; try { binary = atob(file.base64); } catch { throw new AppError('文件编码不完整，请重新选择文件'); }
    if (!binary.length || binary.length > FILE_LIMIT || btoa(binary) !== file.base64) throw new AppError('演示附件需非空、编码完整且不超过500 KiB');
    if (Object.values(doc.files).reduce((sum, value) => sum + value.size, 0) + binary.length > FILES_LIMIT) throw new AppError('演示附件累计最多1 MiB；请改用文字成果或在设置中重置本地演示', 413);
    const id = randomUUID(), name = file.name.split(/[\\/]/).at(-1);
    doc.files[id] = { name, base64: file.base64, size: binary.length };
    action.url = `/api/files/${id}`; action.fileMeta = { name, size: binary.length }; delete action.file;
  }
  async function request(inputURL, payload, { signal } = {}) {
    if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
    const url = new URL(inputURL, 'https://cobuild-demo.invalid'), path = url.pathname;
    if (url.origin !== 'https://cobuild-demo.invalid') throw new AppError('演示适配器仅支持本地API路径');
    if (payload !== undefined && !record(payload)) throw new AppError('请求需要是对象');
    if (payload !== undefined && path === '/api/demo/reset') { const doc = fresh(); persist(doc); return { ...session(doc), workspace: workspace(doc) }; }
    const doc = load(), adapter = identity(doc), current = user(doc), input = payload || {};
    const ids = url.searchParams.getAll('projectId'); if (ids.length > 1) throw new AppError('请只指定一个项目');
    const projectId = payload === undefined ? (ids.length ? ids[0] : undefined) : input.projectId;
    if (path.startsWith('/api/invitations') || (path.startsWith('/api/auth/') && !['/api/auth/session', '/api/auth/logout'].includes(path))) unavailable();
    if (payload === undefined) {
      if (path === '/api/auth/session') return session(doc);
      if (path === '/api/health') return { ok: true, demo: true, app: 'cobuild', authRequired: false };
      if (path === '/api/workspace') return workspace(doc);
      if (path === '/api/dashboard') { const queries = url.searchParams.getAll('q'); if (queries.length > 1) throw new AppError('请只指定一个搜索内容'); return { demo: true, revision: doc.revision, ...dashboardSummary(adapter, doc.projects, current, { query: queries[0] || '', now: now() }) }; }
      if (path === '/api/people') return { demo: true, revision: doc.revision, people: peopleSummary(adapter, doc.projects, current) };
      if (/^\/api\/people\/[A-Za-z0-9_-]+$/.test(path)) return { demo: true, ...personDetails(adapter, doc.projects, current, path.split('/').at(-1)) };
      if (path === '/api/ai/status') return { configured: false, demo: true, samplePlanning: true, provider: 'local-sample', model: DEMO_MODEL, baseUrl: '', fileLimit: FILE_LIMIT, filesLimit: FILES_LIMIT };
      if (path === '/api/state') return decorate(doc, stateFor(doc, projectId));
      if (path === '/api/export') return clone(stateFor(doc, projectId));
      if (path === '/api/report') return projectReport(stateFor(doc, projectId));
      throw new AppError('演示接口不存在', 404);
    }
    if (path === '/api/auth/logout') return session(doc);
    if (path === '/api/projects') return createProject(doc, input);
    const state = stateFor(doc, projectId), action = actor(doc, state, input);
    if (path === '/api/ai/plan' || path === '/api/ai/replan') return samplePlan(doc, state, input, path.endsWith('/replan'));
    if (path === '/api/analyze') return { analysis: analyzeUpdate(state, action), demo: true };
    if (path === '/api/plans/preview') return previewReplan(authorized(doc, state), action);
    let next;
    if (path === '/api/plans/apply') next = applyPlanDraft(authorized(doc, state), action);
    else if (path === '/api/plans/replan') next = applyReplanDraft(authorized(doc, state), action);
    else if (path === '/api/milestones/action') next = applyMilestoneAction(authorized(doc, state), action);
    else if (path === '/api/project-members') {
      const person = adapter.person(input.personId);
      if (adapter.membership(state.project.id, person.id)) throw new AppError('该演示人员已经在项目中', 409);
      const role = input.accessRole || 'member'; if (!['admin', 'member', 'viewer'].includes(role)) throw new AppError('项目访问角色不正确');
      next = applyAction(state, { ...action, type: 'addMember', name: person.name, role: input.role }, { manageProject: true, allowDuplicateNames: true });
      doc.bindings[state.project.id][next.members.at(-1).id] = { personId: person.id, accessRole: role };
    } else if (path === '/api/action') {
      if (action.type === 'submitArtifact' && action.file) attachFile(doc, action);
      else { delete action.fileMeta; if (action.type === 'submitArtifact' && typeof action.url === 'string' && action.url.startsWith('/api/')) throw new AppError('请通过文件选择器提交本地演示附件'); }
      next = reconcileMilestones(applyAction(state, action, { manageProject: true }));
      if (action.type === 'addMember') { const member = next.members.at(-1), person = addPerson(doc, member.name, member.color); doc.bindings[state.project.id][member.id] = { personId: person.id, accessRole: 'member' }; }
    } else throw new AppError('演示接口不存在', 404);
    return { state: saveState(doc, next), ...(path === '/api/project-members' ? { workspace: workspace(doc) } : {}) };
  }
  async function download(inputURL) {
    const url = new URL(inputURL, 'https://cobuild-demo.invalid');
    if (url.origin !== 'https://cobuild-demo.invalid') throw new AppError('此下载不是本地演示文件');
    const doc = load(), projectId = url.searchParams.has('projectId') ? url.searchParams.get('projectId') : undefined;
    if (url.pathname === '/api/export') return { filename: '共建-演示项目.json', blob: new Blob([JSON.stringify(stateFor(doc, projectId), null, 2)], { type: 'application/json;charset=utf-8' }) };
    if (url.pathname === '/api/report') return { filename: '共建-演示进展.md', blob: new Blob([projectReport(stateFor(doc, projectId))], { type: 'text/markdown;charset=utf-8' }) };
    if (doc.samples?.[url.pathname]) { const sample = doc.samples[url.pathname]; return { filename: sample.name, blob: new Blob([sample.text], { type: 'text/markdown;charset=utf-8' }) }; }
    if (/^\/api\/files\/[a-f0-9-]+$/.test(url.pathname)) {
      const file = doc.files[url.pathname.split('/').at(-1)];
      if (!file || !doc.projects.some(state => state.tasks.some(task => task.artifacts.some(item => item.url === url.pathname)))) throw new AppError('本地演示附件不存在', 404);
      return { filename: file.name, blob: new Blob([Uint8Array.from(atob(file.base64), value => value.charCodeAt(0))], { type: 'application/octet-stream' }) };
    }
    throw new AppError('本地演示下载不存在', 404);
  }
  return { request, download, storageKey: key };
}

let browserDemo;
const instance = () => browserDemo ||= createDemoAPI();
export const demoRequest = (url, payload, options) => instance().request(url, payload, options);
export const demoApi = demoRequest;
export async function demoDownload(url) {
  const { blob, filename } = await instance().download(url), href = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = href; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000);
}
