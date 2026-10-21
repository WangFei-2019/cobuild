import { AppError } from './domain.mjs';

export function profileFields(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'bio', 'color'].includes(key))) throw new AppError('人员档案仅支持姓名、简介和头像颜色');
  if (partial && !Object.keys(input).length) throw new AppError('请提供需要修改的档案字段');
  const result = {};
  if (!partial || 'name' in input) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 40) throw new AppError('姓名需要为1–40字');
    result.name = input.name.trim(); result.initial = [...result.name].at(-1);
  }
  if (!partial || 'bio' in input) {
    const bio = input.bio ?? '';
    if (typeof bio !== 'string' || bio.length > 1000) throw new AppError('负责方向/简介最多1000字');
    result.bio = bio.trim();
  }
  if (!partial || 'color' in input) {
    const color = input.color ?? '#427b68';
    if (typeof color !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) throw new AppError('头像颜色需要合法的十六进制颜色');
    result.color = color;
  }
  return result;
}

export function checkProfileDuplicates(people, name, { excludingId, allowDuplicateName = false } = {}) {
  if (typeof allowDuplicateName !== 'boolean') throw new AppError('同名档案确认参数不正确');
  if (!name) return;
  const normalized = value => value.normalize('NFKC').toLocaleLowerCase();
  const matches = people.filter(person => person.id !== excludingId && normalized(person.name) === normalized(name));
  if (matches.length && !allowDuplicateName) {
    const error = new AppError('已有同名人员档案，请先选择已有人员；确认是不同的人后再允许创建同名档案。', 409);
    error.code = 'DUPLICATE_PERSON_NAME'; throw error;
  }
}

// Profiles are authoritative display data; historical project records stay intact.
export function projectWithProfiles(state, identity) {
  return { ...state, members: state.members.map(member => {
    const link = identity.member(state.project.id, member.id);
    if (!link) return { ...member };
    const person = identity.person(link.personId);
    return { ...member, name: person.name, color: person.color, initial: person.initial };
  }) };
}

function projectInfo(state) {
  const p = state.project;
  return { id: p.id, name: p.name, color: p.color || state.members.find(member => member.id === 'm0')?.color || '#427b68',
    description: p.description || '', deadline: p.deadline || '' };
}

function artifactsFor(state, memberId) {
  const result = [];
  const project = projectInfo(state);
  for (const task of state.tasks) {
    for (const [index, artifact] of (task.artifacts || []).entries()) {
      const explicit = typeof artifact.submittedBy === 'string' && Boolean(artifact.submittedBy);
      if ((explicit ? artifact.submittedBy : task.ownerId) !== memberId) continue;
      const isLatest = index === 0;
      const accepted = isLatest && task.status === 'done' && Boolean(task.acceptedAt);
      result.push({ ...artifact, project, taskId: task.id, taskCode: task.code, taskTitle: task.title, taskStatus: task.status,
        acceptedAt: accepted ? task.acceptedAt : '', isLatest,
        acceptanceStatus: accepted ? 'accepted' : !isLatest ? 'historical' : task.status === 'review' ? 'pending' : 'unconfirmed',
        attribution: explicit ? 'submittedBy' : 'taskOwner',
        attributionLabel: explicit ? '本人提交' : '历史记录 · 按任务归属' });
    }
  }
  return result;
}

function statsFor(state, memberId) {
  const owned = state.tasks.filter(task => task.ownerId === memberId);
  const doneCount = owned.filter(task => task.status === 'done').length;
  return { taskCount: owned.length, doneCount,
    blockedCount: owned.filter(task => task.status === 'blocked').length,
    reviewCount: owned.filter(task => task.status === 'review').length,
    toReviewCount: state.tasks.filter(task => task.reviewerId === memberId && task.status === 'review').length,
    artifactCount: artifactsFor(state, memberId).length,
    progress: owned.length ? Math.round(doneCount / owned.length * 100) : null };
}

function participationIndex(identity, visibleStates) {
  const byPerson = new Map();
  for (const state of visibleStates) {
    const project = projectInfo(state);
    for (const member of state.members) {
      const link = identity.member(state.project.id, member.id);
      if (!link) continue;
      const rows = byPerson.get(link.personId) || [];
      rows.push({ state, member, project, stats: statsFor(state, member.id), accessRole: link.accessRole || 'member' });
      byPerson.set(link.personId, rows);
    }
  }
  return byPerson;
}

function summary(rows) {
  const total = { projectCount: rows.length, taskCount: 0, doneCount: 0, blockedCount: 0, reviewCount: 0, toReviewCount: 0, artifactCount: 0 };
  for (const row of rows) for (const field of Object.keys(total)) if (field !== 'projectCount') total[field] += row.stats[field] || 0;
  return { ...total, progress: total.taskCount ? Math.round(total.doneCount / total.taskCount * 100) : null };
}

function canSee(currentUser, personId, rows) {
  return currentUser?.workspaceRole === 'admin' || currentUser?.personId === personId || rows.length > 0;
}

export function peopleSummary(identity, visibleStates, currentUser) {
  const byPerson = participationIndex(identity, visibleStates);
  return identity.people().flatMap(person => {
    const rows = byPerson.get(person.id) || [];
    if (!canSee(currentUser, person.id, rows)) return [];
    return [{ ...person, ...summary(rows), projects: rows.map(row => ({ ...row.project, role: row.member.role,
      memberId: row.member.id, accessRole: row.accessRole, ...row.stats })) }];
  });
}

export function personDetails(identity, visibleStates, currentUser, personId) {
  const person = identity.person(personId);
  const rows = participationIndex(identity, visibleStates).get(personId) || [];
  if (!canSee(currentUser, personId, rows)) throw new AppError('没有找到这个成员档案', 404);
  const tasks = [], artifacts = [], activities = [];
  for (const row of rows) {
    const { state, member, project } = row;
    for (const task of state.tasks) {
      const owner = task.ownerId === member.id, reviewer = task.reviewerId === member.id;
      const contributor = (task.artifacts || []).some(artifact => artifact.submittedBy === member.id);
      if (!owner && !reviewer && !contributor) continue;
      tasks.push({ ...structuredClone(task), project,
        relation: owner && reviewer ? 'owner-reviewer' : owner ? 'owner' : reviewer ? 'reviewer' : 'contributor' });
    }
    artifacts.push(...artifactsFor(state, member.id));
    activities.push(...state.activities.filter(item => item.actorId === member.id).map(item => ({ ...item, project })));
  }
  const recentFirst = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  artifacts.sort(recentFirst); activities.sort(recentFirst);
  return { person, summary: summary(rows),
    projects: rows.map(row => ({ project: row.project, memberId: row.member.id, role: row.member.role, accessRole: row.accessRole, stats: row.stats })),
    tasks, artifacts, activities };
}
