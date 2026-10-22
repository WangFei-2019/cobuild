import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from './domain.mjs';
import { profileFields, checkProfileDuplicates } from './people.mjs';

const scrypt = promisify(scryptCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const roles = new Set(['admin', 'member', 'viewer']);
const id = prefix => `${prefix}-${randomUUID()}`;
const clean = (value, label, max = 100) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`${label}格式不正确`);
  return value.trim();
};
const nicknameKey = value => value.trim().normalize('NFKC').trim().toLowerCase();
function accountFieldConflict(field, code, message) {
  const error = new AppError(message, 409); error.field = field; error.code = code; return error;
}
function email(value) {
  const result = clean(value, '邮箱', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new AppError('请输入有效邮箱');
  return result;
}
function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) throw new AppError('密码需要 12–256 个字符');
  return value;
}
function accessRole(value = 'member') {
  if (!roles.has(value)) throw new AppError('项目访问角色不正确');
  return value;
}

export function createIdentity(dataDir, { projectAvailable = () => true, personVisible = () => true } = {}) {
  const path = join(dataDir, 'identity.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
    INSERT OR IGNORE INTO metadata VALUES('revision',1);
    CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL,initial TEXT NOT NULL,bio TEXT NOT NULL DEFAULT '',createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,personId TEXT NOT NULL UNIQUE REFERENCES people(id),passwordSalt TEXT NOT NULL,passwordHash TEXT NOT NULL,workspaceRole TEXT NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(tokenHash TEXT PRIMARY KEY,accountId TEXT NOT NULL REFERENCES accounts(id),createdAt TEXT NOT NULL,expiresAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS account_onboarding(accountId TEXT NOT NULL REFERENCES accounts(id),version INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('dismissed','completed')),updatedAt TEXT NOT NULL,PRIMARY KEY(accountId,version));
    CREATE TABLE IF NOT EXISTS project_operations(id TEXT PRIMARY KEY,committedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_members(projectId TEXT NOT NULL,memberId TEXT NOT NULL,personId TEXT NOT NULL REFERENCES people(id),accessRole TEXT NOT NULL,PRIMARY KEY(projectId,memberId),UNIQUE(projectId,personId));
    CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,tokenHash TEXT NOT NULL UNIQUE,projectId TEXT NOT NULL,memberId TEXT,personId TEXT REFERENCES people(id),email TEXT NOT NULL DEFAULT '',accessRole TEXT NOT NULL,createdBy TEXT NOT NULL REFERENCES accounts(id),createdAt TEXT NOT NULL,expiresAt TEXT NOT NULL,status TEXT NOT NULL,acceptedBy TEXT REFERENCES accounts(id),acceptedAt TEXT);
    CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,windowStart INTEGER NOT NULL);`);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const bump = () => run("UPDATE metadata SET value=value+1 WHERE key='revision'");
  const transaction = fn => {
    const effects = [];
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = fn(effects);
      if (effects.length) {
        // This marker commits atomically with the identity changes. Startup
        // uses it before reading project JSON or synthesizing any mappings.
        for (const effect of effects) {
          const operationId=id('operation');
          run('INSERT INTO project_operations VALUES(?,?)',operationId,now());
          effect.commit(operationId);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      const failures = [error];
      try { db.exec('ROLLBACK'); } catch (rollbackError) { failures.push(rollbackError); }
      for (const effect of effects.reverse()) try { effect.rollback(); } catch (rollbackError) { failures.push(rollbackError); }
      if (failures.length > 1) throw new AggregateError(failures,'身份事务失败且恢复未完成，请停止写入并检查数据目录');
      throw error;
    }
    // SQL is committed. A cleanup failure must never roll back its JSON.
    // The retained journal is safe: recovery will observe the committed opId.
    for (const effect of effects) try { effect.finalize?.(); } catch(error) { process.stderr.write(`身份联动写入已提交，恢复日志待启动清理：${error.message}\n`); }
    return result;
  };
  const accountCount = () => get('SELECT COUNT(*) AS count FROM accounts').count;
  let registrationsInFlight = 0;
  // Keep legacy names intact, including historical duplicates. Every new
  // account or changed effective nickname is checked in the same write
  // transaction as its mutation, rather than adding a destructive UNIQUE
  // constraint to the shared people directory.
  function assertNicknameAvailable(name, excludingAccountId) {
    const key = nicknameKey(name);
    const occupied = all('SELECT a.id,p.name FROM accounts a JOIN people p ON p.id=a.personId').some(account =>
      account.id !== excludingAccountId && nicknameKey(account.name) === key);
    if (occupied) throw accountFieldConflict('name', 'NAME_TAKEN', '该昵称已被占用');
  }
  function person(personId) {
    if (typeof personId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(personId)) throw new AppError('没有找到这个成员档案',404);
    const value = get('SELECT p.*,a.id AS accountId FROM people p LEFT JOIN accounts a ON a.personId=p.id WHERE p.id=?', personId);
    if (!value) throw new AppError('没有找到这个成员档案', 404);
    return { id: value.id, name: value.name, color: value.color, initial: value.initial, bio: value.bio, accountLinked: Boolean(value.accountId) };
  }
  function newPerson(name, color = '#427b68', initial = [...name].at(-1)) {
    const personId = id('person');
    run('INSERT INTO people(id,name,color,initial,createdAt) VALUES(?,?,?,?,?)', personId, name, color, initial, now());
    return personId;
  }
  function user(accountId) {
    const value = get('SELECT a.id,a.email,a.personId,a.workspaceRole,p.name FROM accounts a JOIN people p ON p.id=a.personId WHERE a.id=?', accountId);
    return value ? { ...value } : null;
  }
  function onboarding(accountId) {
    if (!user(accountId)) throw new AppError('没有找到当前账号', 404);
    const value = get('SELECT status FROM account_onboarding WHERE accountId=? AND version=1', accountId);
    return { version: 1, status: value?.status || 'pending' };
  }
  function session(accountId) {
    const token = randomBytes(32).toString('base64url');
    run('INSERT INTO sessions VALUES(?,?,?,?)', hash(token), accountId, now(), new Date(Date.now() + 7 * 86400000).toISOString());
    return { token, user: user(accountId) };
  }
  function invitationByToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('邀请不存在或已失效', 404);
    const invitation = get('SELECT * FROM invitations WHERE tokenHash=?', hash(token));
    if (!invitation) throw new AppError('邀请不存在或已失效', 404);
    if (!projectAvailable(invitation.projectId)) throw new AppError('邀请所属项目已不可用', 404);
    if (invitation.status !== 'pending') throw new AppError('邀请已经使用或撤销', 410);
    if (invitation.expiresAt <= now()) throw new AppError('邀请已过期', 410);
    return invitation;
  }
  function publicInvitation(value) {
    return { id: value.id, projectId: value.projectId, memberId: value.memberId || null, personId: value.personId || null,
      email: value.email, accessRole: value.accessRole, createdAt: value.createdAt, expiresAt: value.expiresAt,
      status: value.status === 'pending' && value.expiresAt <= now() ? 'expired' : value.status, acceptedAt: value.acceptedAt || '',
      memberName: value.personId ? person(value.personId).name : '' };
  }
  function assertClaimScope(personId, inviterId, projectId) {
    const inviter = user(inviterId);
    if (inviter?.workspaceRole === 'admin') return;
    const projects = new Set([projectId, ...all('SELECT projectId FROM project_members WHERE personId=?', personId).map(link => link.projectId)]);
    if (!inviter || [...projects].some(id => get('SELECT accessRole FROM project_members WHERE projectId=? AND personId=?', id, inviter.personId)?.accessRole !== 'admin')) {
      throw new AppError('这份人员档案关联其他项目，请由有权管理所有关联项目的管理者或工作区管理员核对认领', 403);
    }
  }
  function claim(invitation, current, joinProject, effects) {
    if (invitation.email && invitation.email !== current.email) throw new AppError('请使用邀请指定的邮箱接受', 403);
    let personId = current.personId;
    if (invitation.personId && invitation.personId !== personId) {
      const targetAccount = get('SELECT id FROM accounts WHERE personId=?', invitation.personId);
      if (targetAccount) throw new AppError('该成员档案已绑定其他账号', 409);
      assertClaimScope(invitation.personId, invitation.createdBy, invitation.projectId);
      const target = person(invitation.personId);
      if (nicknameKey(target.name) !== nicknameKey(current.name)) assertNicknameAvailable(target.name, current.id);
      const overlap = get('SELECT 1 FROM project_members a JOIN project_members b ON a.projectId=b.projectId WHERE a.personId=? AND b.personId=? LIMIT 1', personId, invitation.personId);
      if (overlap) throw new AppError('当前账号已在相关项目中，不能认领另一成员档案', 409);
      run('UPDATE project_members SET personId=? WHERE personId=?', invitation.personId, personId);
      run('UPDATE accounts SET personId=? WHERE id=?', invitation.personId, current.id);
      run('UPDATE invitations SET personId=? WHERE personId=?', invitation.personId, personId);
      run('DELETE FROM people WHERE id=?', personId);
      personId = invitation.personId;
    }
    let membership = get('SELECT * FROM project_members WHERE projectId=? AND personId=?', invitation.projectId, personId);
    if (!membership) {
      const joined = joinProject(invitation.projectId, person(personId));
      const memberId = typeof joined === 'string' ? joined : joined.memberId;
      if (typeof joined !== 'string') effects.push(joined.effect);
      run('INSERT INTO project_members VALUES(?,?,?,?)', invitation.projectId, memberId, personId, invitation.accessRole);
      membership = { memberId };
    } else {
      run('UPDATE project_members SET accessRole=? WHERE projectId=? AND memberId=?', invitation.accessRole, invitation.projectId, membership.memberId);
    }
    run("UPDATE invitations SET status='accepted',acceptedBy=?,acceptedAt=? WHERE id=?", current.id, now(), invitation.id);
    bump();
    return { projectId: invitation.projectId, memberId: membership.memberId, invitation: { id: invitation.id, status: 'accepted' }, user: user(current.id) };
  }
  async function passwordFields(value) {
    const salt = randomBytes(16).toString('hex');
    const key = await scrypt(password(value), salt, 64);
    return { salt, key: key.toString('hex') };
  }
  function rateKeys(ip, address) { return [[hash(`account:${ip}:${address}`), 5], [hash(`ip:${ip}`), 30]]; }
  function checkRate(keys, message = '登录尝试过多，请稍后再试') {
    for (const [key, limit] of keys) {
      const value = get('SELECT * FROM login_attempts WHERE key=?', key);
      if (value && Date.now() - value.windowStart < 15 * 60000 && value.count >= limit) {
        const error = new AppError(message, 429); error.retryAfter = Math.max(1, Math.ceil((value.windowStart + 15 * 60000 - Date.now()) / 1000)); throw error;
      }
    }
  }
  function failed(keys) {
    const reservations = [];
    for (const [key] of keys) {
      const value = get('SELECT * FROM login_attempts WHERE key=?', key);
      const fresh = !value || Date.now() - value.windowStart >= 15 * 60000;
      const windowStart = fresh ? Date.now() : value.windowStart;
      run('INSERT INTO login_attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,windowStart=excluded.windowStart', key, fresh ? 1 : value.count + 1, windowStart);
      reservations.push({ key, windowStart });
    }
    return reservations;
  }
  function releaseSuccessfulAttempt(reservations) {
    for (const { key, windowStart } of reservations) run('UPDATE login_attempts SET count=count-1 WHERE key=? AND windowStart=? AND count>0', key, windowStart);
  }
  return {
    close() { db.close(); }, revision() { return get("SELECT value FROM metadata WHERE key='revision'").value; },
    operationCommitted(operationId) { return Boolean(get('SELECT 1 FROM project_operations WHERE id=?',operationId)); },
    setupRequired() { return accountCount() === 0; }, person,
    people() { return all('SELECT id FROM people').filter(value => personVisible(value.id)).map(value => person(value.id)); },
    createPerson(input, { allowDuplicateName = false } = {}) {
      const fields = profileFields(input);
      return transaction(() => {
        checkProfileDuplicates(all('SELECT id,name FROM people'), fields.name, { allowDuplicateName });
        const personId = newPerson(fields.name, fields.color, fields.initial);
        run('UPDATE people SET bio=? WHERE id=?', fields.bio, personId); bump(); return person(personId);
      });
    },
    updatePerson(personId, patch, { allowDuplicateName = false } = {}) {
      const fields = profileFields(patch, { partial: true });
      return transaction(() => {
        const previous = person(personId), next = { ...previous, ...fields };
        const account = get('SELECT id FROM accounts WHERE personId=?', personId), changedNickname = nicknameKey(next.name) !== nicknameKey(previous.name);
        if (account && changedNickname) assertNicknameAvailable(next.name, account.id);
        checkProfileDuplicates(all('SELECT id,name FROM people'), changedNickname ? next.name : undefined, { excludingId: personId, allowDuplicateName });
        run('UPDATE people SET name=?,bio=?,color=?,initial=? WHERE id=?', next.name, next.bio, next.color, next.initial, personId);
        bump(); return person(personId);
      });
    },
    user, onboarding,
    updateOnboarding(accountId, status) {
      if (!['dismissed','completed'].includes(status)) throw new AppError('指引状态只支持dismissed或completed');
      return transaction(() => {
        const current = onboarding(accountId);
        // A delayed dismissal from another tab must not undo completion.
        if (current.status === 'completed' || current.status === status) return current;
        run('INSERT INTO account_onboarding(accountId,version,status,updatedAt) VALUES(?,1,?,?) ON CONFLICT(accountId,version) DO UPDATE SET status=excluded.status,updatedAt=excluded.updatedAt', accountId, status, now());
        return { version: 1, status };
      });
    },
    sessionUser(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const value = get('SELECT accountId,expiresAt FROM sessions WHERE tokenHash=?', hash(token));
      if (!value) return null;
      if (value.expiresAt <= now()) { run('DELETE FROM sessions WHERE tokenHash=?', hash(token)); return null; }
      return user(value.accountId);
    },
    logout(token) { if (typeof token === 'string') run('DELETE FROM sessions WHERE tokenHash=?', hash(token)); },
    async setup(input) {
      if (accountCount()) throw new AppError('工作区已完成初始化，请登录', 409);
      const name = clean(input.name, '姓名', 40), address = email(input.email);
      const fields = await passwordFields(input.password);
      return transaction(() => {
        if (accountCount()) throw new AppError('工作区已完成初始化，请登录', 409);
        const personId = newPerson(name), accountId = id('account');
        run('INSERT INTO accounts VALUES(?,?,?,?,?,?,?)', accountId, address, personId, fields.salt, fields.key, 'admin', now());
        bump(); return session(accountId);
      });
    },
    async login(input, ip) {
      const address = email(input.email), keys = rateKeys(ip, address);
      checkRate(keys);
      // Reserve the attempt before awaiting scrypt so concurrent requests cannot evade the limit.
      const reservations = failed(keys);
      if (typeof input.password !== 'string' || input.password.length > 256) throw new AppError('邮箱或密码不正确', 401);
      const account = get('SELECT * FROM accounts WHERE email=?', address);
      const salt = account?.passwordSalt || '0'.repeat(32);
      const supplied = await scrypt(input.password, salt, 64);
      const expected = Buffer.from(account?.passwordHash || '0'.repeat(128), 'hex');
      if (!account || !timingSafeEqual(supplied, expected)) throw new AppError('邮箱或密码不正确', 401);
      // Release only this successful request, never another request's failure or
      // reservation. Proxies may put every legitimate user in the same IP bucket.
      releaseSuccessfulAttempt(reservations);
      return session(account.id);
    },
    async register(input, joinProject, ip = 'unknown') {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name','email','password','inviteToken'].includes(key))) throw new AppError('注册仅支持昵称、邮箱、密码与可选邀请令牌');
      if (!accountCount()) throw new AppError('请先由部署者完成工作区管理员初始化，再注册个人账号', 409);
      const name = clean(input.name, '昵称', 40), address = email(input.email);
      password(input.password);
      const invited = Object.hasOwn(input, 'inviteToken');
      if (invited) invitationByToken(input.inviteToken);
      const keys = [[hash(`signup:email:${address}`), 5], [hash(`signup:ip:${ip}`), 30]];
      checkRate(keys, '注册请求过多，请稍后再试');
      if (registrationsInFlight >= 4) { const error = new AppError('当前注册请求较多，请稍后重试', 429); error.retryAfter = 1; throw error; }
      // Persist before scrypt so parallel requests and restarts cannot evade the
      // window. Source addresses are socket peers; arbitrary forwarded headers
      // never grant additional quota behind a shared reverse proxy.
      failed(keys); registrationsInFlight += 1;
      try {
        const fields = await passwordFields(input.password);
        return transaction(effects => {
          const invitation = invited ? invitationByToken(input.inviteToken) : null;
          if (invitation?.email && invitation.email !== address) throw new AppError('请使用邀请指定的邮箱注册', 403);
          if (get('SELECT id FROM accounts WHERE email=?', address)) throw accountFieldConflict('email', 'EMAIL_TAKEN', '该邮箱已注册');
          if (invitation?.personId) {
            if (get('SELECT id FROM accounts WHERE personId=?', invitation.personId)) throw new AppError('该成员档案已绑定账号', 409);
            assertClaimScope(invitation.personId, invitation.createdBy, invitation.projectId);
            // Claiming an existing profile preserves that profile's display
            // name, which may differ from the submitted registration nickname.
          }
          assertNicknameAvailable(invitation?.personId ? person(invitation.personId).name : name);
          const personId = invitation?.personId || newPerson(name), accountId = id('account');
          run('INSERT INTO accounts VALUES(?,?,?,?,?,?,?)', accountId, address, personId, fields.salt, fields.key, 'member', now());
          const accepted = invitation ? claim(invitation, user(accountId), joinProject, effects) : null;
          if (!accepted) bump();
          return { ...session(accountId), ...(accepted ? { projectId: accepted.projectId } : {}) };
        });
      } finally { registrationsInFlight -= 1; }
    },
    syncProject(state, bindings = new Map(), effect) {
      transaction(effects => {
        if(effect)effects.push(effect);
        for (const member of state.members) {
          const existing = get('SELECT * FROM project_members WHERE projectId=? AND memberId=?', state.project.id, member.id);
          if (existing) continue;
          const binding = bindings.get(member.id);
          const personId = binding?.personId || newPerson(member.name, member.color || '#427b68', member.initial || [...member.name].at(-1));
          person(personId);
          run('INSERT INTO project_members VALUES(?,?,?,?)', state.project.id, member.id, personId, accessRole(binding?.accessRole || (member.id === 'm0' ? 'admin' : 'member')));
          bump();
        }
      });
    },
    membership(projectId, personId) { const value = get('SELECT * FROM project_members WHERE projectId=? AND personId=?', projectId, personId); return value ? { ...value } : null; },
    member(projectId, memberId) { const value = get('SELECT * FROM project_members WHERE projectId=? AND memberId=?', projectId, memberId); return value ? { ...value, accountLinked: person(value.personId).accountLinked } : null; },
    memberships(personId) { return all('SELECT * FROM project_members WHERE personId=?', personId).map(value => ({ ...value })); },
    invite(input, current) {
      if (!projectAvailable(input.projectId)) throw new AppError('邀请所属项目已不可用', 404);
      const role = accessRole(input.accessRole);
      const address = input.email == null || input.email === '' ? '' : email(input.email);
      let member = null;
      if (input.memberId !== undefined && input.memberId !== null && input.memberId !== '') {
        if (typeof input.memberId !== 'string') throw new AppError('成员标识不正确');
        member = get('SELECT * FROM project_members WHERE projectId=? AND memberId=?', input.projectId, input.memberId);
        if (!member) throw new AppError('没有找到这个项目成员', 404);
        if (person(member.personId).accountLinked) throw new AppError('该成员已经绑定账号', 409);
      }
      let targetPersonId = member?.personId || null;
      if (input.personId !== undefined && input.personId !== null && input.personId !== '') {
        const target = person(input.personId);
        if (member && target.id !== member.personId) throw new AppError('邀请指定的成员和人员档案不一致');
        if (!member && get('SELECT 1 FROM project_members WHERE projectId=? AND personId=?', input.projectId, target.id)) throw new AppError('该人员已经是项目成员', 409);
        const targetAccount = get('SELECT email FROM accounts WHERE personId=?', target.id);
        if (address && targetAccount && targetAccount.email !== address) throw new AppError('邀请邮箱与指定账号不一致');
        targetPersonId = target.id;
      }
      if (targetPersonId && !person(targetPersonId).accountLinked) assertClaimScope(targetPersonId, current.id, input.projectId);
      const token = randomBytes(32).toString('base64url');
      const invitation = { id: id('invitation'), projectId: input.projectId, memberId: member?.memberId || null, personId: targetPersonId, email: address,
        accessRole: role, createdAt: now(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), status: 'pending' };
      run('INSERT INTO invitations(id,tokenHash,projectId,memberId,personId,email,accessRole,createdBy,createdAt,expiresAt,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)', invitation.id, hash(token), invitation.projectId, invitation.memberId, invitation.personId, address, role, current.id, invitation.createdAt, invitation.expiresAt, 'pending');
      bump(); return { ...publicInvitation(invitation), token };
    },
    resolveInvitation(token) { return publicInvitation(invitationByToken(token)); },
    invitations(projectId) { return all('SELECT * FROM invitations WHERE projectId=? ORDER BY createdAt DESC', projectId).map(publicInvitation); },
    invitation(idValue) { if (typeof idValue !== 'string') throw new AppError('邀请标识不正确'); const value = get('SELECT * FROM invitations WHERE id=?', idValue); if (!value) throw new AppError('邀请不存在', 404); return publicInvitation(value); },
    revoke(idValue) {
      const value = get('SELECT * FROM invitations WHERE id=?', idValue);
      if (!value) throw new AppError('邀请不存在', 404);
      if (value.status !== 'pending') throw new AppError('邀请已使用或撤销', 409);
      run("UPDATE invitations SET status='revoked' WHERE id=?", idValue); bump();
      return publicInvitation({ ...value, status: 'revoked' });
    },
    accept(token, current, joinProject) { return transaction(effects => claim(invitationByToken(token), user(current.id), joinProject, effects)); }
  };
}
