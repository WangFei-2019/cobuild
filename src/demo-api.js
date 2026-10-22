import seed from '../demo/seed.json' with { type: 'json' };
import { randomUUID } from 'node:crypto';
import { AppError, applyAction, analyzeUpdate, projectReport } from '../domain.mjs';
import { applyPlanDraft, validatePlanDraft, applyMilestoneAction, reconcileMilestones, previewReplan, applyReplanDraft } from '../planning.mjs';
import { dashboardSummary } from '../dashboard.mjs';
import {deriveNotifications,notificationReadIds,notificationView} from '../notifications.mjs';
import { buildSampleState, markSampleState, isSampleState, sampleOwner, sampleInfo, sampleProjectInput } from '../sample.mjs';
import { peopleSummary, personDetails, profileFields, checkProfileDuplicates, projectWithProfiles } from '../people.mjs';

export const DEMO_STORAGE_KEY = 'cobuild.pages.demo.v1';
export const DEMO_MODEL = '内置示例 · 非AI生成';
const FILE_LIMIT = 500 * 1024, FILES_LIMIT = 1024 * 1024;
const clone = value => structuredClone(value);
const ONBOARDING_VERSION = 1;
const onboardingState = doc => clone(doc.onboarding || {version:ONBOARDING_VERSION,status:'pending'});
const validOnboarding = value => record(value) && Object.keys(value).length === 2 && value.version === ONBOARDING_VERSION && ['pending','dismissed','completed'].includes(value.status);
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
    && Array.isArray(value.projects) && Array.isArray(value.people) && record(value.bindings) && record(value.files)
    && value.projects.every(state => state?.schemaVersion === 1 && state.project?.id && Number.isSafeInteger(state.revision)
      && ['members', 'tasks', 'activities', 'decisions'].every(key => Array.isArray(state[key])))
    && (value.projects.length ? value.projects.some(state => state.project.id === value.defaultProjectId) : value.defaultProjectId === null)
    && (!Object.hasOwn(value,'archivedSamples') || Array.isArray(value.archivedSamples) && value.archivedSamples.every(entry => record(entry) && isSampleState(entry.state) && typeof entry.archivedAt === 'string'))
    && (!Object.hasOwn(value,'archivedProjects') || Array.isArray(value.archivedProjects) && value.archivedProjects.every(entry=>record(entry)&&!isSampleState(entry.state)&&entry.state?.project?.id&&typeof entry.archivedAt==='string'))
    && (!Object.hasOwn(value,'notificationReads') || record(value.notificationReads)&&Object.values(value.notificationReads).every(ids=>Array.isArray(ids)&&ids.every(id=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id))))
    && value.people.some(person => person.id === value.currentPersonId)
    && (!Object.hasOwn(value,'onboarding') || validOnboarding(value.onboarding));
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
    doc.onboarding = {version:ONBOARDING_VERSION,status:'pending'};
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
    return { person, people: () => {
      const archivedVirtual = new Set((doc.archivedSamples || []).flatMap(entry => entry.state.members.filter(item => item.virtual).map(item => doc.bindings[entry.state.project.id]?.[item.id]?.personId)));
      const activePeople = new Set(doc.projects.flatMap(state => Object.values(doc.bindings[state.project.id] || {}).map(item => item.personId)));
      return clone(doc.people.filter(item => !archivedVirtual.has(item.id) || activePeople.has(item.id) || item.id === doc.currentPersonId));
    }, member, membership(projectId, personId) {
      const item = Object.entries(doc.bindings[projectId] || {}).find(([, value]) => value.personId === personId);
      return item ? member(projectId, item[0]) : null;
    } };
  }
  function user(doc) {
    const person = identity(doc).person(doc.currentPersonId);
    return { id: 'demo-experience-session', name: person.name, email: 'demo@local.invalid', personId: person.id, workspaceRole: 'admin', emailVerified:false,demo: true };
  }
  const session = doc => ({ setupRequired: false, setupTokenRequired: false, demo: true, user: user(doc), onboarding:onboardingState(doc),capabilities:{mailConfigured:false} });
  function stateFor(doc, projectId) {
    const id = projectId === undefined ? doc.defaultProjectId : projectId;
    if (id === null && projectId === undefined) throw new AppError('当前演示没有可见项目',404);
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) throw new AppError('项目标识不正确');
    const state = doc.projects.find(value => value.project.id === id);
    if (!state) throw new AppError('没有找到这个演示项目', 404);
    return projectWithProfiles(state,identity(doc));
  }
  const permissions = { manageProject: true, createTask: true, readOnly: false };
  function decorate(doc, state) {
    const adapter = identity(doc);
    const named = projectWithProfiles(state,adapter);
    return { ...clone(named), demo: true, members: named.members.map(member => ({ ...clone(member), ...adapter.member(state.project.id, member.id) })),
      currentMemberId: adapter.membership(state.project.id, doc.currentPersonId)?.memberId || null, sample:sampleInfo(state,user(doc).id), permissions: { ...permissions,canArchive:!isSampleState(state), ...(isSampleState(state)?{manageMembers:false}:{}) } };
  }
  function authorized(doc, state) {
    const value = decorate(doc, state);
    for (const member of value.members) if (member.id === value.currentMemberId) member.accessRole = 'admin';
    return value;
  }
  function workspace(doc) {
    return { revision: doc.revision, defaultProjectId: doc.defaultProjectId, currentPersonId: doc.currentPersonId, demo: true,
      permissions: { createProject: true, manageWorkspace: true }, archivedProjects:(doc.archivedProjects||[]).map(archivedProjectView),archivedSamples:(doc.archivedSamples || []).filter(entry=>sampleOwner(entry.state)===user(doc).id).map(archivedSampleView), projects: doc.projects.map(state => {
        const value = decorate(doc, state), p = state.project;
        return { ...clone(p), description: p.description || '', goal: p.goal || '', deadline: p.deadline || '', color: p.color || '#427b68',
          ownerName: value.members.find(member => member.id === 'm0')?.name || '', memberCount: state.members.length,
          taskCount: state.tasks.length, doneCount: state.tasks.filter(task => task.status === 'done').length,
          blockedCount: state.tasks.filter(task => task.status === 'blocked').length, reviewCount: state.tasks.filter(task => task.status === 'review').length,
          sample:value.sample, permissions:value.permissions, members: value.members };
      }) };
  }
  function cleanState(next) {
    const clean = clone(next); delete clean.demo; delete clean.currentMemberId; delete clean.permissions;
    clean.members = clean.members.map(member => {
      const { personId, accountLinked, accessRole, projectId, memberId, ...original } = member; return original;
    });
    return clean;
  }
  const exportState = (doc,state) => ({...clone(projectWithProfiles(state,identity(doc))),sample:sampleInfo(state,user(doc).id)});
  function saveState(doc, next) {
    const clean = cleanState(next);
    const previous = doc.projects.find(state=>state.project.id===clean.project.id);
    if (isSampleState(previous)) clean.sample=clone(previous.sample); else delete clean.sample;
    for (const member of clean.members) {
      const stored = previous.members.find(item=>item.id===member.id);
      if (stored) for (const field of ['name','color','initial']) { if (Object.hasOwn(stored,field)) member[field]=stored[field]; else delete member[field]; }
    }
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
  function virtualSamplePerson(doc,personId) {
    return [...doc.projects,...(doc.archivedSamples || []).map(entry=>entry.state)].some(state=>isSampleState(state)
      && state.members.some(member=>member.virtual===true && doc.bindings[state.project.id]?.[member.id]?.personId===personId));
  }
  function createProject(doc, input, {persistChanges=true} = {}) {
    if (Object.keys(input).some(field => !['name', 'description', 'goal', 'deadline', 'ownerName', 'ownerRole', 'ownerPersonId', 'color', 'members'].includes(field))) throw new AppError('包含不支持的项目字段');
    if (input.members !== undefined && !Array.isArray(input.members)) throw new AppError('初始成员格式不正确');
    if ((input.members || []).length > 31) throw new AppError('每个演示项目最多支持32名成员');
    const adapter = identity(doc), owner = adapter.person(input.ownerPersonId || doc.currentPersonId), color = input.color || '#427b68';
    if(virtualSamplePerson(doc,owner.id))throw new AppError('示例虚拟伙伴不能成为真实项目发起人',403);
    if (typeof color !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) throw new AppError('项目颜色需要合法的十六进制颜色');
    const createdAt = now().toISOString(), projectId = `project-${randomUUID()}`;
    const members = [{ id: 'm0', name: owner.name, role: text(input.ownerRole, '发起人职责', 80) || '项目发起人', color, initial: owner.initial }];
    const bindings = { m0: { personId: owner.id, accessRole: 'admin' } }, seen = new Set([owner.id]);
    for (const [index, value] of (input.members || []).entries()) {
      if (!record(value) || Object.keys(value).some(field => !['name', 'personId', 'role'].includes(field))) throw new AppError('初始成员格式不正确');
      const person = value.personId ? adapter.person(value.personId) : addPerson(doc, value.name);
      if(virtualSamplePerson(doc,person.id))throw new AppError('示例虚拟伙伴不能加入真实项目',403);
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
    doc.bindings[projectId] = bindings; doc.projects.push(state); doc.defaultProjectId ||= projectId; doc.revision += 1; if(persistChanges)persist(doc);
    return { state: decorate(doc, state), workspace: workspace(doc) };
  }
  function archivedSampleView(entry) {
    const {state,archivedAt}=entry;
    return {id:state.project.id,name:state.project.name,color:state.project.color,revision:state.revision,archivedAt,sample:{version:1,canRestore:true}};
  }
  const archivedProjectView=entry=>({id:entry.state.project.id,name:entry.state.project.name,color:entry.state.project.color||'#427b68',revision:entry.state.revision,archivedAt:entry.archivedAt,canRestore:true});
  function realProjectArchive(doc,input,restore){
    sampleInput(input,restore?['projectId']:['projectId','expectedRevision']);
    const active=doc.projects.find(state=>state.project.id===input.projectId),entry=(doc.archivedProjects||[]).find(item=>item.state.project.id===input.projectId),state=active||entry?.state;
    if(!state)throw new AppError('没有找到这个项目',404);
    if(isSampleState(state))throw new AppError('示例请使用专属移除与恢复入口',403);
    if(restore){
      if(active)return {state:decorate(doc,state),workspace:workspace(doc),reused:true,restored:false};
      doc.projects.push(state);doc.archivedProjects=doc.archivedProjects.filter(item=>item!==entry);doc.defaultProjectId ||=state.project.id;doc.revision+=1;persist(doc);
      return {state:decorate(doc,state),workspace:workspace(doc),reused:false,restored:true};
    }
    if(!Number.isSafeInteger(input.expectedRevision))throw new AppError('请提供归档所依据的项目版本');
    if(input.expectedRevision!==state.revision)throw new AppError('项目已有更新，请核对最新内容后再归档',409);
    if(entry)return {workspace:workspace(doc),archivedProject:archivedProjectView(entry),alreadyArchived:true};
    const archived={state:clone(state),archivedAt:now().toISOString()};doc.archivedProjects=[...(doc.archivedProjects||[]),archived];doc.projects=doc.projects.filter(item=>item!==active);
    if(doc.defaultProjectId===state.project.id)doc.defaultProjectId=doc.projects[0]?.project.id||null;doc.revision+=1;persist(doc);
    return {workspace:workspace(doc),archivedProject:archivedProjectView(archived),alreadyArchived:false};
  }
  function inbox(doc){return deriveNotifications(identity(doc),visibleStates(doc),user(doc),{now:now()});}
  function inboxView(doc){return notificationView(inbox(doc),new Set(doc.notificationReads?.[user(doc).id]||[]));}
  function accountView(doc){const person=identity(doc).person(doc.currentPersonId);return {account:{...user(doc),bio:person.bio||'',color:person.color,initial:person.initial,emailVerified:false,emailVerifiedAt:''},capabilities:{mailConfigured:false}};}
  function sampleInput(input,keys) {
    if(Object.keys(input).length!==keys.length || Object.keys(input).some(key=>!keys.includes(key))) throw new AppError('示例请求包含不支持的字段');
    if(keys.includes('projectId') && (typeof input.projectId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.projectId))) throw new AppError('项目标识不正确');
  }
  function assertOwnSample(doc,state) {
    if(!isSampleState(state)) throw new AppError('只能移除或恢复由应用创建的示例项目',403);
    if(sampleOwner(state)!==user(doc).id) throw new AppError('只能管理当前体验账号创建的示例项目',403);
  }
  function restoreSample(doc,projectId) {
    const active=doc.projects.find(state=>state.project.id===projectId);
    if(active){assertOwnSample(doc,active);return {state:decorate(doc,active),workspace:workspace(doc),reused:true,restored:false};}
    const entry=(doc.archivedSamples || []).find(item=>item.state.project.id===projectId);
    if(!entry)throw new AppError('没有找到这个已移除示例',404);
    assertOwnSample(doc,entry.state);
    doc.archivedSamples=doc.archivedSamples.filter(item=>item!==entry);
    doc.projects.push(entry.state);doc.defaultProjectId ||= projectId;doc.revision+=1;persist(doc);
    return {state:decorate(doc,entry.state),workspace:workspace(doc),reused:false,restored:true};
  }
  function createSample(doc,input) {
    sampleInput(input,[]);
    const active=doc.projects.find(state=>sampleOwner(state)===user(doc).id);
    if(active)return {state:decorate(doc,active),workspace:workspace(doc),reused:true,restored:false};
    const archived=(doc.archivedSamples || []).find(entry=>sampleOwner(entry.state)===user(doc).id);
    if(archived)return restoreSample(doc,archived.state.project.id);
    createProject(doc,sampleProjectInput(user(doc).name),{persistChanges:false});
    const index=doc.projects.length-1,base=doc.projects[index];
    base.activities=[];
    const todayParts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now()).map(part=>[part.type,part.value]));
    const today=todayParts.year+'-'+todayParts.month+'-'+todayParts.day;
    const state=markSampleState(buildSampleState(base,{today}),user(doc).id);
    doc.projects[index]=state;
    const virtualId=doc.bindings[state.project.id].m1.personId;
    doc.people.find(person=>person.id===virtualId).bio='内置示例虚拟伙伴，没有真实账号。';
    persist(doc);
    return {state:decorate(doc,state),workspace:workspace(doc),reused:false,restored:false};
  }
  function archiveSample(doc,input) {
    sampleInput(input,['projectId','expectedRevision']);
    const active=doc.projects.find(state=>state.project.id===input.projectId),existing=(doc.archivedSamples || []).find(entry=>entry.state.project.id===input.projectId),state=active || existing?.state;
    if(!state)throw new AppError('没有找到这个示例项目',404);
    assertOwnSample(doc,state);
    if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision!==state.revision)throw new AppError('示例已有更新，请刷新后再移除',409);
    if(existing)return {workspace:workspace(doc),archivedSample:archivedSampleView(existing),alreadyArchived:true};
    const entry={state:clone(state),archivedAt:now().toISOString()};
    doc.projects=doc.projects.filter(item=>item!==active);doc.archivedSamples=[...(doc.archivedSamples || []),entry];
    if(doc.defaultProjectId===input.projectId)doc.defaultProjectId=doc.projects[0]?.project.id || null;
    doc.revision+=1;persist(doc);
    return {workspace:workspace(doc),archivedSample:archivedSampleView(entry),alreadyArchived:false};
  }
  const peoplePermissions = {managePeople:true,createPerson:true,editProfile:true};
  const profileView = (doc,person) => ({...clone(person),permissions:{editProfile:!virtualSamplePerson(doc,person.id)}});
  const visibleStates = doc => doc.projects.map(state=>projectWithProfiles(state,identity(doc)));
  function writePerson(doc,input,personId) {
    const create = personId === undefined, allowed = create ? ['name','bio','color','allowDuplicateName'] : ['expectedRevision','patch','allowDuplicateName'];
    if (Object.keys(input).some(key=>!allowed.includes(key))) throw new AppError('包含不支持的人员档案字段');
    if (input.allowDuplicateName !== undefined && typeof input.allowDuplicateName !== 'boolean') throw new AppError('同名档案确认参数不正确');
    if (!create && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision!==doc.revision)) throw new AppError('人员目录已有更新，请刷新档案后重新保存',409);
    if(!create&&virtualSamplePerson(doc,personId))throw new AppError('示例虚拟伙伴使用固定档案，不能修改为真实人员',403);
    const {allowDuplicateName=false,...fields}=input, previous = create ? null : identity(doc).person(personId);
    const patch = profileFields(create ? fields : input.patch,{partial:!create});
    checkProfileDuplicates(doc.people,create || patch.name!==previous.name ? patch.name : undefined,{excludingId:personId,allowDuplicateName});
    const person = create ? {id:`person-${randomUUID()}`,...patch,accountLinked:false} : {...previous,...patch};
    if (create) doc.people.push(person); else doc.people[doc.people.findIndex(value=>value.id===personId)]=person;
    doc.revision+=1;persist(doc);
    return {person:profileView(doc,person),revision:doc.revision,permissions:{...peoplePermissions},session:session(doc)};
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
  async function request(inputURL, payload, { signal,method } = {}) {
    if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
    const url = new URL(inputURL, 'https://cobuild-demo.invalid'), path = url.pathname;
    if (url.origin !== 'https://cobuild-demo.invalid') throw new AppError('演示适配器仅支持本地API路径');
    if (payload !== undefined && !record(payload)) throw new AppError('请求需要是对象');
    if (payload !== undefined && path === '/api/demo/reset') { const doc = fresh(); persist(doc); return { ...session(doc), workspace: workspace(doc) }; }
    const doc = load(), adapter = identity(doc), current = user(doc), input = payload || {};
    const ids = url.searchParams.getAll('projectId'); if (ids.length > 1) throw new AppError('请只指定一个项目');
    const projectId = payload === undefined ? (ids.length ? ids[0] : undefined) : input.projectId;
    if(['/api/account/password','/api/account/email-verification','/api/auth/forgot-password','/api/auth/reset-password','/api/auth/verify-email'].includes(path)){const error=new AppError(path.endsWith('/password')?'演示版不能更改真实密码，请使用正式账号服务。':'演示版没有邮件服务，未发送邮件、未验证邮箱或修改密码。',503);error.code=path.endsWith('/password')?'DEMO_UNAVAILABLE':'MAIL_NOT_CONFIGURED';throw error;}
    if (path.startsWith('/api/invitations') || (path.startsWith('/api/auth/') && !['/api/auth/session', '/api/auth/logout', '/api/auth/onboarding'].includes(path))) unavailable();
    if (payload === undefined) {
      if (path === '/api/auth/session') return session(doc);
      if (path === '/api/health') return { ok: true, demo: true, app: 'cobuild', authRequired: false };
      if (path === '/api/workspace') return workspace(doc);
      if(path==='/api/account')return accountView(doc);
      if(path==='/api/notifications')return inboxView(doc);
      if (path === '/api/dashboard') { const queries = url.searchParams.getAll('q'); if (queries.length > 1) throw new AppError('请只指定一个搜索内容'); return { demo: true, revision: doc.revision, ...dashboardSummary(adapter, visibleStates(doc), current, { query: queries[0] || '', now: now() }) }; }
      if (path === '/api/people') {
        const selected=url.searchParams.getAll('selectableForProject');if(selected.length>1)throw new AppError('请只指定一个项目');
        if(selected.length)stateFor(doc,selected[0]);
        return {demo:true,revision:doc.revision,permissions:{...peoplePermissions},people:(selected.length?adapter.people().filter(person=>!virtualSamplePerson(doc,person.id)):peopleSummary(adapter,visibleStates(doc),current)).map(person=>profileView(doc,person))};
      }
      if (/^\/api\/people\/[A-Za-z0-9_-]+$/.test(path)) {const id=path.split('/').at(-1);if(!adapter.people().some(person=>person.id===id))throw new AppError('没有找到这个成员档案',404);const detail=personDetails(adapter,visibleStates(doc),current,id);return {demo:true,...detail,person:profileView(doc,detail.person),revision:doc.revision,permissions:{...peoplePermissions,editProfile:!virtualSamplePerson(doc,id)}};}
      if (path === '/api/ai/status') return { configured: false, demo: true, samplePlanning: true, provider: 'local-sample', model: DEMO_MODEL, baseUrl: '', fileLimit: FILE_LIMIT, filesLimit: FILES_LIMIT };
      if (path === '/api/ai/capabilities') { stateFor(doc,projectId); return { configured:false,samplePlanning:true,canGenerate:true }; }
      if (path === '/api/state') return decorate(doc, stateFor(doc, projectId));
      if (path === '/api/export') return exportState(doc,stateFor(doc, projectId));
      if (path === '/api/report') return projectReport(projectWithProfiles(stateFor(doc, projectId),adapter));
      throw new AppError('演示接口不存在', 404);
    }
    if (path === '/api/auth/logout') return session(doc);
    if(path==='/api/account'){
      if(method!=='PATCH')throw new AppError('账户资料请使用 PATCH',405);
      const patch=profileFields(input,{partial:true}),person=identity(doc).person(doc.currentPersonId),normalized=value=>value.trim().normalize('NFKC').trim().toLowerCase();
      if(patch.name&&normalized(patch.name)!==normalized(person.name)&&doc.people.some(item=>item.id!==person.id&&item.accountLinked&&normalized(item.name)===normalized(patch.name))){const error=new AppError('该昵称已被占用',409);error.code='NAME_TAKEN';error.field='name';throw error;}
      Object.assign(doc.people.find(item=>item.id===person.id),patch);doc.revision+=1;persist(doc);return {...accountView(doc),session:session(doc)};
    }
    if(path==='/api/notifications/read'){
      const selected=notificationReadIds(input,inbox(doc)),accountId=user(doc).id,previous=new Set(doc.notificationReads?.[accountId]||[]);for(const id of selected)previous.add(id);
      doc.notificationReads={...(doc.notificationReads||{}),[accountId]:[...previous]};persist(doc);return inboxView(doc);
    }
    if (path === '/api/auth/onboarding') {
      if (Object.keys(input).length !== 1 || !Object.hasOwn(input,'status') || !['dismissed','completed'].includes(input.status)) throw new AppError('使用指引仅支持当前体验账号的 dismissed 或 completed 状态');
      const previous = onboardingState(doc);
      if (previous.status !== 'completed' && previous.status !== input.status) {
        doc.onboarding = {version:ONBOARDING_VERSION,status:input.status};
        persist(doc);
      }
      return {onboarding:onboardingState(doc)};
    }
    if (path === '/api/people') return writePerson(doc,input);
    if (/^\/api\/people\/[A-Za-z0-9_-]+$/.test(path)) return writePerson(doc,input,path.split('/').at(-1));
    if (path === '/api/samples') return createSample(doc,input);
    if (path === '/api/samples/archive') return archiveSample(doc,input);
    if (path === '/api/samples/restore') {sampleInput(input,['projectId']);return restoreSample(doc,input.projectId);}
    if (path === '/api/projects') return createProject(doc, input);
    if(path==='/api/projects/archive'||path==='/api/projects/restore')return realProjectArchive(doc,input,path.endsWith('/restore'));
    const state = stateFor(doc, projectId), action = actor(doc, state, input);
    if(isSampleState(state) && (path==='/api/project-members'||path==='/api/action'&&['addMember','updateMember'].includes(action.type)))throw new AppError('示例使用固定虚拟伙伴，真实协作请创建自己的项目',403);
    if (path === '/api/ai/plan' || path === '/api/ai/replan') return samplePlan(doc, state, input, path.endsWith('/replan'));
    if (path === '/api/analyze') return { analysis: analyzeUpdate(state, action), demo: true };
    if (path === '/api/plans/preview') return previewReplan(authorized(doc, state), action);
    let next;
    if (path === '/api/plans/apply') next = applyPlanDraft(authorized(doc, state), action);
    else if (path === '/api/plans/replan') next = applyReplanDraft(authorized(doc, state), action);
    else if (path === '/api/milestones/action') next = applyMilestoneAction(authorized(doc, state), action);
    else if (path === '/api/project-members') {
      const person = adapter.person(input.personId);
      if(virtualSamplePerson(doc,person.id))throw new AppError('示例虚拟伙伴不能加入真实项目',403);
      if (adapter.membership(state.project.id, person.id)) throw new AppError('该演示人员已经在项目中', 409);
      const role = input.accessRole || 'member'; if (!['admin', 'member', 'viewer'].includes(role)) throw new AppError('项目访问角色不正确');
      next = applyAction(state, { ...action, type: 'addMember', name: person.name, role: input.role }, { manageProject: true, allowDuplicateNames: true });
      doc.bindings[state.project.id][next.members.at(-1).id] = { personId: person.id, accessRole: role };
    } else if (path === '/api/action') {
      if(action.type==='updateMember'&&!Number.isSafeInteger(action.expectedRevision))throw new AppError('请提供成员编辑所依据的项目版本');
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
    if (url.pathname === '/api/export') return { filename: '共建-演示项目.json', blob: new Blob([JSON.stringify(exportState(doc,stateFor(doc, projectId)), null, 2)], { type: 'application/json;charset=utf-8' }) };
    if (url.pathname === '/api/report') return { filename: '共建-演示进展.md', blob: new Blob([projectReport(projectWithProfiles(stateFor(doc, projectId),identity(doc)))], { type: 'text/markdown;charset=utf-8' }) };
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
