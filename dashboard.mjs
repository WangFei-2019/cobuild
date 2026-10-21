import { AppError } from './domain.mjs';

const LIMIT = 200;
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = rows => rows.sort((a, b) => compare(a.due || '9999-99-99', b.due || '9999-99-99')
  || compare(a.project.id, b.project.id) || compare(a.code, b.code) || compare(a.id, b.id));
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase();
const page = rows => ({ tasks: rows.slice(0, LIMIT), total: rows.length, hasMore: rows.length > LIMIT });

// The caller supplies only states that the current account is allowed to read.
// Local member IDs are never assumed to represent the same person across projects.
export function dashboardSummary(identity, states, currentUser, { query = '', now = new Date() } = {}) {
  if (typeof query !== 'string' || query.length > 120) throw new AppError('搜索内容最多 120 字');
  query = query.trim();
  const parts = Object.fromEntries(dayFormat.formatToParts(now).map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const end = new Date(`${today}T00:00:00.000Z`); end.setUTCDate(end.getUTCDate() + 7);
  const dueEnd = end.toISOString().slice(0, 10), needle = normalize(query);
  const sections = { todo: [], toReview: [], blocked: [], dueSoon: [] }, matches = [];
  for (const state of states) {
    const p = state.project;
    const project = { id: p.id, name: p.name, color: p.color || state.members.find(member => member.id === 'm0')?.color || '#427b68' };
    const membership = currentUser?.personId ? identity?.membership(p.id, currentUser.personId) : null;
    const currentMemberId = state.members.some(member => member.id === membership?.memberId) ? membership.memberId : null;
    const memberInfo = id => ({ id, name: state.members.find(member => member.id === id)?.name || '未分配' });
    for (const task of state.tasks) {
      const owned = Boolean(currentMemberId && task.ownerId === currentMemberId);
      const reviewing = Boolean(currentMemberId && task.reviewerId === currentMemberId);
      const unfinished = task.status !== 'done', due = task.due || '';
      const isOverdue = Boolean(unfinished && due && due < today);
      const isDueSoon = Boolean(unfinished && due && due >= today && due <= dueEnd);
      const row = { id: task.id, code: task.code || '', title: task.title || '', status: task.status,
        priority: task.priority || 'medium', due, blocker: task.blocker || '', updatedAt: task.updatedAt || '', milestoneId: task.milestoneId || '',
        project, currentMemberId, relation: owned && reviewing ? 'owner-reviewer' : owned ? 'owner' : reviewing ? 'reviewer' : null,
        owner: memberInfo(task.ownerId), reviewer: memberInfo(task.reviewerId), isOverdue, isDueSoon };
      if (owned && unfinished) sections.todo.push(row);
      if (reviewing && task.status === 'review') sections.toReview.push(row);
      if (owned && task.status === 'blocked') sections.blocked.push(row);
      if ((owned || (reviewing && task.status === 'review')) && unfinished && (isOverdue || isDueSoon)) sections.dueSoon.push(row);
      if (needle && [task.code, task.title, task.description, task.deliverable].some(value => normalize(value).includes(needle))) matches.push(row);
    }
  }
  const summary = {}, sectionMeta = {};
  for (const [name, rows] of Object.entries(sections)) {
    const result = page(sorted(rows));
    summary[name] = result.total; sectionMeta[name] = { total: result.total, hasMore: result.hasMore };
    sections[name] = result.tasks;
  }
  return { generatedAt: now.toISOString(), today, currentPersonId: currentUser?.personId || null,
    summary, sections, sectionMeta, search: { query, ...page(sorted(matches)) } };
}
