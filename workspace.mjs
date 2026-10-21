import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, seedState } from './domain.mjs';

const COLORS = ['#427b68', '#b47e59', '#7770a3', '#6387a2'];
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validState = value => record(value) && value.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.revision > 0
  && record(value.project) && validId(value.project.id)
  && ['members', 'tasks', 'activities', 'decisions'].every(key => Array.isArray(value[key]));

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
  if (initialMembers.length > 31) throw new AppError('体验版最多支持 32 名成员');
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

export function createWorkspace(dataDir, { seedDemo = false } = {}) {
  if (typeof seedDemo !== 'boolean') throw new Error('seedDemo 需要为布尔值，仅供显式示例或测试初始化');
  mkdirSync(join(dataDir, 'projects'), { recursive: true });
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
      && (!originalId || value.projectIds.includes(originalId)));
  } else {
    index = { schemaVersion: 1, revision: 1, defaultProjectId: originalId, projectIds: originalId ? [originalId] : [] };
    writeJSON(indexPath, index);
  }
  const states = new Map(original ? [[originalId, original]] : []);
  const pathFor = id => id === originalId ? originalPath : join(dataDir, 'projects', `${id}.json`);
  for (const id of index.projectIds) {
    if (id === originalId) continue;
    states.set(id, readJSON(pathFor(id), value => validState(value) && value.project.id === id));
  }

  function resolveId(requestedId) {
    const id = requestedId === undefined ? index.defaultProjectId : requestedId;
    if (requestedId === undefined && id === null) throw new AppError('工作区还没有项目，请先创建项目', 404);
    if (!validId(id)) throw new AppError('项目标识不正确');
    if (!states.has(id)) throw new AppError('没有找到这个项目', 404);
    return id;
  }

  function view(projectIds = index.projectIds) {
    return {
      revision: index.revision, defaultProjectId: projectIds.includes(index.defaultProjectId) ? index.defaultProjectId : projectIds[0] || null,
      projects: projectIds.map(id => {
        const state = states.get(id), p = state.project;
        return {
          id, name: p.name, description: p.description || '', goal: p.goal || '', deadline: p.deadline || '', stage: p.stage || '',
          color: p.color || state.members.find(member => member.id === 'm0')?.color || COLORS[0], createdAt: p.createdAt || '',
          ownerName: state.members.find(member => member.id === 'm0')?.name || '', memberCount: state.members.length, taskCount: state.tasks.length,
          doneCount: state.tasks.filter(task => task.status === 'done').length,
          blockedCount: state.tasks.filter(task => task.status === 'blocked').length,
          reviewCount: state.tasks.filter(task => task.status === 'review').length,
          members: state.members.map(({ id, name, role, color, initial }) => ({ id, name, role, color, initial }))
        };
      })
    };
  }

  function save(requestedId, next) {
    const id = resolveId(requestedId);
    if (!validState(next) || next.project.id !== id) throw new Error('项目状态或标识不正确');
    const nextIndex = { ...index, revision: index.revision + 1 };
    const path = pathFor(id), previousBytes = readFileSync(path);
    writeJSON(path, next);
    try { writeJSON(indexPath, nextIndex); }
    catch (error) {
      // A failed second write must not leave disk ahead of memory or an upload
      // pointing at a file that the HTTP error handler will remove.
      try { writeAtomic(path, previousBytes); }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], '项目索引写入和项目恢复均失败，请停止写入并检查数据目录');
      }
      throw error;
    }
    states.set(id, next); index = nextIndex;
    return next;
  }

  return {
    resolveId, view,
    allStates() { return [...states.values()]; },
    state(requestedId) { return states.get(resolveId(requestedId)); },
    save,
    create(input, options = {}) {
      const state = creationState(input, options);
      if (options.decorate) options.decorate(state);
      const id = state.project.id;
      const nextIndex = { ...index, revision: index.revision + 1, defaultProjectId: index.defaultProjectId || id, projectIds: [...index.projectIds, id] };
      const path = pathFor(id);
      writeJSON(path, state);
      try { writeJSON(indexPath, nextIndex); }
      catch (error) { unlinkSync(path); throw error; }
      states.set(id, state); index = nextIndex;
      return { state, workspace: view() };
    },
    reset(requestedId, { preserveProject = false } = {}) {
      const id = resolveId(requestedId), current = states.get(id);
      let next;
      if (seedDemo && id === originalId && !preserveProject) {
        next = seedState(); next.project.id = id;
      } else {
        next = structuredClone(current);
        next.tasks = []; next.decisions = []; next.milestones = [];
        next.activities = [{ id: `event-${randomUUID()}`, actorId: 'm0', taskId: '', kind: 'reset', text: `清空项目「${next.project.name}」的任务与交接记录。`, createdAt: new Date().toISOString() }];
      }
      next.revision = current.revision + 1;
      return save(id, next);
    },
    artifact(pathname) {
      for (const state of states.values()) {
        const artifact = state.tasks.flatMap(task => task.artifacts || []).find(item => item.url === pathname && item.fileName);
        if (artifact) return artifact;
      }
      return undefined;
    }
  };
}
