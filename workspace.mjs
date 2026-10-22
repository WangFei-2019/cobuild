import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, seedState } from './domain.mjs';
import { isSampleState, sampleOwner } from './sample.mjs';

const COLORS = ['#427b68', '#b47e59', '#7770a3', '#6387a2'];
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validState = value => record(value) && value.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.revision > 0
  && record(value.project) && validId(value.project.id)
  && ['members', 'tasks', 'activities', 'decisions'].every(key => Array.isArray(value[key]))
  && validDiscussions(value);

function validDiscussions(state){
  if(state.discussions===undefined)return true;
  if(!Array.isArray(state.discussions)||state.discussions.length>1000)return false;
  const ids=new Set(),perTask=new Map(),memberIds=new Set(state.members.map(item=>item.id));
  for(const entry of state.discussions){
    if(!record(entry)||!validId(entry.id)||ids.has(entry.id)||!state.tasks.some(task=>task.id===entry.taskId)||!memberIds.has(entry.authorId)
      ||typeof entry.body!=='string'||!entry.body.trim()||entry.body.length>4000||!['comment','question'].includes(entry.kind)
      ||!Array.isArray(entry.mentionIds)||entry.mentionIds.length>20||new Set(entry.mentionIds).size!==entry.mentionIds.length||entry.mentionIds.some(id=>!memberIds.has(id))
      ||typeof entry.createdAt!=='string'||!Number.isFinite(Date.parse(entry.createdAt)))return false;
    if(entry.replyTo!==null&&(!validId(entry.replyTo)||!state.discussions.some(parent=>parent.id===entry.replyTo&&parent.taskId===entry.taskId)||entry.kind==='question'))return false;
    if(entry.resolved!==false&&(!record(entry.resolved)||entry.kind!=='question'||entry.replyTo!==null||!memberIds.has(entry.resolved.actorId)||!Number.isFinite(Date.parse(entry.resolved.createdAt))))return false;
    ids.add(entry.id);const count=(perTask.get(entry.taskId)||0)+1;if(count>200)return false;perTask.set(entry.taskId,count);
  }
  return true;
}

function writeAtomic(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, value, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function writeJSON(path, value) {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJSON(path, validate) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!validate(value)) throw new Error('schema');
    return value;
  } catch {
    throw new Error(`本地数据文件无法读取，已保留原文件。请检查 ${path}`);
  }
}

function text(value, label, max, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max) throw new AppError(`${label}格式不正确，最多 ${max} 字`);
  const result = value.trim();
  if (required && !result) throw new AppError(`请填写${label}`);
  return result;
}

function date(value) {
  const result = text(value, '截止日期', 10);
  if (!result) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new AppError('日期格式应为 YYYY-MM-DD');
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw new AppError('请选择有效日期');
  return result;
}

function creationState(input, { allowDuplicateNames = false } = {}) {
  if (!record(input)) throw new AppError('请求格式不正确');
  const allowed = new Set(['name', 'description', 'goal', 'deadline', 'ownerName', 'ownerRole', 'color', 'members']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new AppError('包含不支持的项目字段');
  const name = text(input.name, '项目名称', 100, true);
  const ownerName = text(input.ownerName, '发起人姓名', 40, true);
  const ownerRole = text(input.ownerRole, '发起人职责', 80) || '项目发起人';
  const description = text(input.description, '项目简介', 500);
  const goal = text(input.goal, '项目目标', 1500);
  const deadline = date(input.deadline);
  let color = text(input.color, '项目颜色', 9) || COLORS[0];
  if (!/^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(color)) throw new AppError('项目颜色需要使用合法的十六进制颜色');
  if (input.members !== undefined && !Array.isArray(input.members)) throw new AppError('初始成员格式不正确');
  const initialMembers = input.members || [];
  if (initialMembers.length > 31) throw new AppError('每个项目最多支持 32 名成员');
  const members = [{ id: 'm0', name: ownerName, role: ownerRole, color, initial: [...ownerName].at(-1) }];
  const names = new Set([ownerName.normalize('NFKC').toLocaleLowerCase()]);
  for (const [index, candidate] of initialMembers.entries()) {
    if (!record(candidate) || Object.keys(candidate).some(key => !['name', 'role'].includes(key))) throw new AppError('初始成员格式不正确');
    const memberName = text(candidate.name, '成员姓名', 40, true);
    const normalizedName = memberName.normalize('NFKC').toLocaleLowerCase();
    if (!allowDuplicateNames && names.has(normalizedName)) throw new AppError('已存在同名成员，请增加区分信息');
    names.add(normalizedName);
    members.push({ id: `m${index + 1}`, name: memberName, role: text(candidate.role, '成员职责', 80) || '项目协作者', color: COLORS[(index + 1) % COLORS.length], initial: [...memberName].at(-1) });
  }
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: 1, revision: 1,
    project: { id: `project-${randomUUID()}`, name, description, goal, deadline, stage: '项目启动', color, createdAt },
    members, tasks: [], decisions: [],
    activities: [{ id: `event-${randomUUID()}`, actorId: 'm0', taskId: '', kind: 'create', text: `创建项目「${name}」。`, createdAt }]
  };
}

function recoverOperations(dataDir, operationCommitted) {
  const directory = join(dataDir,'.transactions');
  if (!existsSync(directory)) return;
  const entries = readdirSync(directory).filter(name=>name.endsWith('.json'));
  if (entries.length && typeof operationCommitted !== 'function') throw new Error('存在未清理的身份联动写入日志，必须通过正式身份数据库恢复后再打开工作区');
  const bytes = path => existsSync(path) ? readFileSync(path) : null;
  const equal = (a,b) => a === null || b === null ? a === b : a.equals(b);
  const decode = value => {
    if (value === null) return null;
    if (typeof value !== 'string') throw new Error('日志字节格式不正确');
    const result=Buffer.from(value,'base64');
    if (result.toString('base64') !== value) throw new Error('日志字节格式不正确');
    return result;
  };
  for (const name of entries.sort()) {
    const path=join(directory,name);
    let entry;
    try {
      entry=JSON.parse(readFileSync(path,'utf8'));
      if (entry.schemaVersion !== 1 || !validId(entry.projectId) || !validId(entry.operationId) || name !== `${entry.operationId}.json`) throw new Error('schema');
      const projectPath=entry.original ? join(dataDir,'project.json') : join(dataDir,'projects',`${entry.projectId}.json`),indexPath=join(dataDir,'workspace.json');
      const oldProject=decode(entry.previousProject),nextProject=decode(entry.nextProject),oldIndex=decode(entry.previousIndex),nextIndex=decode(entry.nextIndex);
      if (!nextProject || !oldIndex || !nextIndex || typeof entry.original !== 'boolean') throw new Error('schema');
      const committed=operationCommitted(entry.operationId);
      const targets=[[projectPath,oldProject,nextProject,'project'],[indexPath,oldIndex,nextIndex,'index']];
      // Validate every file before restoring any file. An uncommitted operation
      // cannot overwrite unrelated or later legitimate contents.
      for (const [target,oldValue,nextValue,kind] of targets) {
        const current=bytes(target);
        if (equal(current,oldValue) || equal(current,nextValue)) continue;
        if (!committed || current===null) throw new Error('恢复快照与磁盘内容不一致');
        const later=JSON.parse(current),expected=JSON.parse(nextValue);
        if (!Number.isSafeInteger(later.revision) || later.revision < expected.revision || (kind==='project' && later.project?.id!==entry.projectId)) throw new Error('恢复快照与磁盘内容不一致');
      }
      for (const [target,oldValue,nextValue] of targets) {
        const current=bytes(target);
        if (committed) { if (equal(current,oldValue)) writeAtomic(target,nextValue); }
        else if (!equal(current,oldValue)) { if (oldValue===null) unlinkSync(target); else writeAtomic(target,oldValue); }
      }
      unlinkSync(path);
    } catch (error) { throw new Error(`身份联动写入日志恢复失败，已保留数据和日志 ${path}：${error.message}`); }
  }
}

export function createWorkspace(dataDir, { seedDemo = false, operationCommitted } = {}) {
  if (typeof seedDemo !== 'boolean') throw new Error('seedDemo 需要为布尔值，仅供显式示例或测试初始化');
  mkdirSync(join(dataDir, 'projects'), { recursive: true });
  recoverOperations(dataDir,operationCommitted);
  const originalPath = join(dataDir, 'project.json');
  const indexPath = join(dataDir, 'workspace.json');
  if (!existsSync(indexPath) && readdirSync(join(dataDir, 'projects')).some(name => name.endsWith('.json'))) {
    throw new Error('项目目录中已有数据但缺少 workspace.json 索引，已保留原文件。请先恢复工作区索引');
  }
  // Existing records always win. A persisted empty workspace must stay empty,
  // even when an isolated test later opts into demo initialization.
  if (seedDemo && !existsSync(indexPath) && !existsSync(originalPath)) writeJSON(originalPath, seedState());
  const original = existsSync(originalPath) ? readJSON(originalPath, validState) : null;
  const originalId = original?.project.id || null;
  let index;
  if (existsSync(indexPath)) {
    index = readJSON(indexPath, value => record(value) && value.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.revision > 0
      && Array.isArray(value.projectIds) && value.projectIds.every(validId) && new Set(value.projectIds).size === value.projectIds.length
      && (value.projectIds.length === 0 ? value.defaultProjectId === null : validId(value.defaultProjectId) && value.projectIds.includes(value.defaultProjectId))
      && (value.archivedProjects === undefined || Array.isArray(value.archivedProjects) && value.archivedProjects.every(item => record(item) && validId(item.id) && typeof item.archivedAt === 'string' && Number.isFinite(Date.parse(item.archivedAt)))
        && new Set(value.archivedProjects.map(item => item.id)).size === value.archivedProjects.length && value.archivedProjects.every(item => !value.projectIds.includes(item.id)))
      && (!originalId || value.projectIds.includes(originalId) || value.archivedProjects?.some(item=>item.id===originalId)));
  } else {
    index = { schemaVersion: 1, revision: 1, defaultProjectId: originalId, projectIds: originalId ? [originalId] : [] };
    writeJSON(indexPath, index);
  }
  const states = new Map(original ? [[originalId, original]] : []);
  const pathFor = id => id === originalId ? originalPath : join(dataDir, 'projects', `${id}.json`);
  for (const id of [...index.projectIds, ...(index.archivedProjects || []).map(item => item.id)]) {
    if (id === originalId) continue;
    states.set(id, readJSON(pathFor(id), value => validState(value) && value.project.id === id));
  }

  function resolveId(requestedId) {
    const id = requestedId === undefined ? index.defaultProjectId : requestedId;
    if (requestedId === undefined && id === null) throw new AppError('工作区还没有项目，请先创建项目', 404);
    if (!validId(id)) throw new AppError('项目标识不正确');
    if (!states.has(id) || !index.projectIds.includes(id)) throw new AppError('没有找到这个项目', 404);
    return id;
  }

  function view(projectIds = index.projectIds) {
    projectIds = projectIds.filter(id => index.projectIds.includes(id));
    return {
      revision: index.revision, defaultProjectId: projectIds.includes(index.defaultProjectId) ? index.defaultProjectId : projectIds[0] || null,
      projects: projectIds.map(id => {
        const state = states.get(id), p = state.project;
        return {
          id, name: p.name, description: p.description || '', goal: p.goal || '', deadline: p.deadline || '', stage: p.stage || '',
          color: p.color || state.members.find(member => member.id === 'm0')?.color || COLORS[0], createdAt: p.createdAt || '',
          ownerName: state.members.find(member => member.id === 'm0')?.name || '', memberCount: state.members.filter(member=>member.active!==false).length, taskCount: state.tasks.filter(task=>task.status!=='canceled').length, canceledCount:state.tasks.filter(task=>task.status==='canceled').length,
          doneCount: state.tasks.filter(task => task.status === 'done').length,
          blockedCount: state.tasks.filter(task => task.status === 'blocked').length,
          reviewCount: state.tasks.filter(task => task.status === 'review').length,
          members: state.members.filter(member=>member.active!==false).map(({ id, name, role, color, initial }) => ({ id, name, role, color, initial }))
        };
      })
    };
  }

  let writeFailure = null;
  const writable = () => { if (writeFailure) throw new Error('此前写入恢复未完成，请停止写入并检查数据目录',{cause:writeFailure}); };
  function stageMutation(id,next,{creating=false}={}) {
    writable();
    if (!validState(next) || next.project.id !== id) throw new Error('项目状态或标识不正确');
    if (!creating && JSON.stringify(next.sample) !== JSON.stringify(states.get(id).sample)) throw new AppError('不能修改项目的示例归属标记');
    const previousIndex=index,previousState=states.get(id),nextIndex={...index,revision:index.revision+1,
      ...(creating ? {defaultProjectId:index.defaultProjectId||id,projectIds:[...index.projectIds,id]} : {})};
    const path=pathFor(id),previousBytes=creating?null:readFileSync(path),previousIndexBytes=readFileSync(indexPath);
    let committed=false,journalPath=null;
    const removeJournal=()=>{if(journalPath&&existsSync(journalPath))unlinkSync(journalPath);journalPath=null;};
    const restoreFiles=()=>{if(previousBytes===null){if(existsSync(path))unlinkSync(path);}else writeAtomic(path,previousBytes);writeAtomic(indexPath,previousIndexBytes);};
    return {
      commit(operationId) {
        writable();
        if (committed) return;
        if (index !== previousIndex || states.get(id) !== previousState) throw new AppError('项目已有更新，请核对最新内容后重新操作',409);
        if (operationId) {
          if (!validId(operationId)) throw new Error('身份联动写入标识不正确');
          const directory=join(dataDir,'.transactions');mkdirSync(directory,{recursive:true,mode:0o700});journalPath=join(directory,`${operationId}.json`);
          const encode=value=>value===null?null:Buffer.from(value).toString('base64');
          writeJSON(journalPath,{schemaVersion:1,operationId,projectId:id,original:id===originalId,
            previousProject:encode(previousBytes),nextProject:encode(`${JSON.stringify(next,null,2)}\n`),previousIndex:encode(previousIndexBytes),nextIndex:encode(`${JSON.stringify(nextIndex,null,2)}\n`)});
        }
        try { writeJSON(path,next);writeJSON(indexPath,nextIndex); }
        catch (error) {
          try { restoreFiles();removeJournal(); }
          catch (rollbackError) { writeFailure=rollbackError;throw new AggregateError([error,rollbackError],'项目索引写入和项目恢复均失败，请停止写入并检查数据目录'); }
          throw error;
        }
        states.set(id,next);index=nextIndex;committed=true;
      },
      rollback() {
        if (!committed) return;
        // Identity transactions and these effects are synchronous in one
        // process. Refuse to compensate over any later legitimate mutation.
        if (index !== nextIndex || states.get(id) !== next) { writeFailure=new Error('回滚快照已变化，请停止写入并检查数据目录');throw writeFailure; }
        try { restoreFiles();removeJournal(); }
        catch(error) { writeFailure=error;throw error; }
        if(creating)states.delete(id);else states.set(id,previousState);index=previousIndex;committed=false;
      },
      finalize() { removeJournal(); }
    };
  }
  function stageSave(requestedId,next) { return stageMutation(resolveId(requestedId),next); }
  function save(requestedId,next,{persist}={}) {
    const effect=stageSave(requestedId,next);
    if(persist)persist(effect);else effect.commit();
    return next;
  }

  function storedState(id) {
    if(!validId(id))throw new AppError('项目标识不正确');
    const current=states.get(id);if(!current)throw new AppError('没有找到这个项目',404);return current;
  }
  function archive(id,expectedRevision) {
    writable();const current=storedState(id);
    if(!Number.isSafeInteger(expectedRevision))throw new AppError('请提供归档所依据的项目版本');
    if(current.revision!==expectedRevision)throw new AppError('项目已有更新，请核对最新内容后再归档',409);
    const existing=(index.archivedProjects||[]).find(item=>item.id===id);
    if(existing)return {state:current,archivedAt:existing.archivedAt,alreadyArchived:true};
    const archivedAt=new Date().toISOString(),projectIds=index.projectIds.filter(value=>value!==id);
    const nextIndex={...index,revision:index.revision+1,projectIds,defaultProjectId:projectIds.includes(index.defaultProjectId)?index.defaultProjectId:projectIds[0]||null,
      archivedProjects:[...(index.archivedProjects||[]),{id,archivedAt}]};
    writeJSON(indexPath,nextIndex);index=nextIndex;return {state:current,archivedAt,alreadyArchived:false};
  }
  function restore(id) {
    writable();const current=storedState(id);
    if(index.projectIds.includes(id))return {state:current,reused:true,restored:false};
    const nextIndex={...index,revision:index.revision+1,projectIds:[...index.projectIds,id],defaultProjectId:index.defaultProjectId||id,
      archivedProjects:(index.archivedProjects||[]).filter(item=>item.id!==id)};
    writeJSON(indexPath,nextIndex);index=nextIndex;return {state:current,reused:false,restored:true};
  }

  return {
    resolveId, view,
    allStates() { return index.projectIds.map(id => states.get(id)); },
    allStoredStates() { return [...states.values()]; },
    isActive(id) { return index.projectIds.includes(id); },
    storedState(id) { if (!validId(id)) throw new AppError('项目标识不正确'); const state = states.get(id); if (!state) throw new AppError('没有找到这个项目',404); return state; },
    archivedEntries() { return (index.archivedProjects || []).map(item => ({ state:states.get(item.id), archivedAt:item.archivedAt })); },
    state(requestedId) { return states.get(resolveId(requestedId)); },
    save, stageSave,
    create(input, options = {}) {
      writable();
      const state = creationState(input, options);
      if (options.decorate) options.decorate(state);
      const id = state.project.id;
      const effect=stageMutation(id,state,{creating:true});
      if(options.persist)options.persist(state,effect);else effect.commit();
      return { state, workspace: view() };
    },
    archiveProject(id, { expectedRevision } = {}) {
      const current = storedState(id);
      if (isSampleState(current)) throw new AppError('示例请使用专属移除入口',403);
      return archive(id,expectedRevision);
    },
    restoreProject(id) {
      if (isSampleState(storedState(id))) throw new AppError('示例请使用专属恢复入口',403);
      return restore(id);
    },
    archiveSample(id, { ownerAccountId, expectedRevision } = {}) {
      const current = storedState(id);
      if (!isSampleState(current) || sampleOwner(current) !== ownerAccountId) throw new AppError('只能移除由当前账号创建的示例项目',403);
      return archive(id,expectedRevision);
    },
    restoreSample(id, { ownerAccountId } = {}) {
      const current = storedState(id);
      if (!isSampleState(current) || sampleOwner(current) !== ownerAccountId) throw new AppError('只能恢复由当前账号创建的示例项目',403);
      if (!index.projectIds.includes(id) && index.projectIds.some(projectId => sampleOwner(states.get(projectId)) === ownerAccountId)) throw new AppError('当前账号已有活跃示例，请先移除后再恢复另一份',409);
      return restore(id);
    },
    reset(requestedId, { preserveProject = false } = {}) {
      const id = resolveId(requestedId), current = states.get(id);
      let next;
      if (seedDemo && id === originalId && !preserveProject) {
        next = seedState(); next.project.id = id;
      } else {
        next = structuredClone(current);
        next.tasks = []; next.decisions = []; next.milestones = [];next.discussions=[];
        next.activities = [{ id: `event-${randomUUID()}`, actorId: 'm0', taskId: '', kind: 'reset', text: `清空项目「${next.project.name}」的任务与交接记录。`, createdAt: new Date().toISOString() }];
      }
      next.revision = current.revision + 1;
      return save(id, next);
    },
    artifact(pathname) {
      for (const state of index.projectIds.map(id => states.get(id))) {
        const artifact = state.tasks.flatMap(task => task.artifacts || []).find(item => item.url === pathname && item.fileName);
        if (artifact) return artifact;
      }
      return undefined;
    }
  };
}
