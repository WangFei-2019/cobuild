import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { applyAction, analyzeUpdate, projectReport, AppError } from './domain.mjs';
import { createWorkspace } from './workspace.mjs';
import { createIdentity } from './identity.mjs';
import { peopleSummary, personDetails } from './people.mjs';
import { dashboardSummary } from './dashboard.mjs';
import { aiStatus, generatePlan, applyPlanDraft, applyMilestoneAction, reconcileMilestones, generateReplan, previewReplan, applyReplanDraft } from './planning.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.md':'text/plain; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png'};
const COOKIE = 'cobuild_session';
const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\]|(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.[\d.]+)(?::\d+)?$/;
const pagePath = /^\/(?:dashboard|projects(?:\/[A-Za-z0-9_-]+\/(?:overview|tasks|mine|members|milestones|deliverables|insights|activity|settings))?|people(?:\/[A-Za-z0-9_-]+)?|settings|login|setup|invite\/[A-Za-z0-9_-]{43})\/?$/;
const validRole = value => { const role = value ?? 'member'; if (!['admin','member','viewer'].includes(role)) throw new AppError('项目访问角色不正确'); return role; };
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const loopbackHost = hostname => ['localhost','[::1]','::1'].includes(hostname) || /^127(?:\.\d{1,3}){3}$/.test(hostname);

function aiLimiter() {
  const configuredInteger = (name, fallback, max) => {
    const value = process.env[name] || String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${name} 需要为 1–${max} 的整数`);
    return Number(value);
  };
  const accountCalls = configuredInteger('COBUILD_AI_RATE_LIMIT', 10, 1000);
  const windowSeconds = configuredInteger('COBUILD_AI_RATE_WINDOW_SECONDS', 600, 86400);
  const accounts = new Map(); let inFlight = 0;
  function reject(message, seconds = 1) {
    const error = new AppError(message, 429); error.retryAfter = Math.max(1, Math.ceil(seconds)); throw error;
  }
  return {
    limits: { accountConcurrency: 1, globalConcurrency: 4, accountCalls, windowSeconds },
    acquire(accountId) {
      const now = Date.now(), windowMs = windowSeconds * 1000;
      for (const [key, entry] of accounts) if (!entry.inFlight && now - entry.startedAt >= windowMs) accounts.delete(key);
      const entry = accounts.get(accountId) || { startedAt: now, calls: 0, inFlight: 0 };
      if (now - entry.startedAt >= windowMs) { entry.startedAt = now; entry.calls = 0; }
      if (entry.inFlight) reject('当前账号已有规划正在生成，请稍后再试');
      if (inFlight >= 4) reject('当前生成请求较多，请稍后再试');
      if (entry.calls >= accountCalls) reject('当前账号的规划调用次数已达上限，请稍后再试', (entry.startedAt + windowMs - now) / 1000);
      entry.calls += 1; entry.inFlight += 1; inFlight += 1; accounts.set(accountId, entry);
      return () => { entry.inFlight -= 1; inFlight -= 1; };
    }
  };
}

function deploymentURL(publicUrl) {
  if (!publicUrl) return null;
  let deployment;
  try {
    deployment = new URL(publicUrl);
    if (!['http:','https:'].includes(deployment.protocol) || deployment.username || deployment.password || deployment.pathname !== '/' || deployment.search || deployment.hash) throw new Error();
  } catch { throw new Error('COBUILD_PUBLIC_URL 需要使用完整的 http/https 站点地址'); }
  if (!loopbackHost(deployment.hostname) && deployment.protocol !== 'https:') throw new Error('非回环 COBUILD_PUBLIC_URL 必须使用 HTTPS');
  return deployment;
}

export function validateServerConfig({host = '127.0.0.1',port = 4173,publicUrl = ''} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['127.0.0.1','0.0.0.0','localhost'].includes(host)) throw new Error('端口或监听地址不正确');
  const deployment = deploymentURL(publicUrl);
  if (host === '0.0.0.0' && deployment?.protocol !== 'https:') throw new Error('监听 0.0.0.0 需要配置 HTTPS COBUILD_PUBLIC_URL');
  return {host,port,publicUrl:deployment?.origin || ''};
}

// authRequired:false exists exclusively for isolated legacy tests; the CLI never disables authentication.
export function createApp({ dataDir = process.env.COBUILD_DATA_DIR || join(ROOT, '.local'), authRequired = true,
  publicUrl = process.env.COBUILD_PUBLIC_URL || '', setupToken = process.env.COBUILD_SETUP_TOKEN || '' } = {}) {
  mkdirSync(join(dataDir, 'files'), { recursive: true });
  const deployment = deploymentURL(publicUrl);
  const secureCookie = deployment?.protocol === 'https:';
  const remoteDeployment = deployment && !loopbackHost(deployment.hostname);
  const workspace = createWorkspace(dataDir);
  const identity = authRequired ? createIdentity(dataDir) : null;
  const aiRequests = aiLimiter();
  if (identity) for (const state of workspace.allStates()) identity.syncProject(state);
  const revision = () => workspace.view().revision + (identity?.revision() || 0);

  function send(res, status, value, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer', ...extra});
    res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  }
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError('请求需要使用 JSON 格式', 415);
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new AppError('请求过大，单文件请控制在 5MB 内', 413); chunks.push(chunk); }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('JSON 内容无法解析'); }
    if (!plainObject(input)) throw new AppError('请求格式不正确');
    return input;
  }
  const sessionView = user => ({ setupRequired:identity?.setupRequired() || false, setupTokenRequired:Boolean(identity?.setupRequired() && (remoteDeployment || setupToken)), user });
  const sessionCookie = (token, expired = false) => `${COOKIE}=${expired ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expired ? 0 : 604800}${secureCookie ? '; Secure' : ''}`;
  function cookieToken(req) {
    return (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
  }
  function canRead(state, user) { return user.workspaceRole === 'admin' || Boolean(identity.membership(state.project.id, user.personId)); }
  function visibleStates(user) { return authRequired ? workspace.allStates().filter(state => canRead(state, user)) : workspace.allStates(); }
  function permissions(state, user) {
    const membership = identity.membership(state.project.id, user.personId);
    const manageProject = user.workspaceRole === 'admin' || membership?.accessRole === 'admin';
    const write = manageProject || membership?.accessRole === 'member';
    return { manageProject, createTask:Boolean(write), readOnly:!write };
  }
  function decoratedState(state, user) {
    if (!authRequired) return state;
    return { ...state, members:state.members.map(member => ({...member, ...identity.member(state.project.id, member.id)})), currentMemberId:identity.membership(state.project.id,user.personId)?.memberId || null, permissions:permissions(state,user) };
  }
  function workspaceView(user) {
    if (!authRequired) return workspace.view();
    const value = workspace.view(visibleStates(user).map(state => state.project.id));
    value.revision = revision();
    value.currentPersonId = user.personId;
    value.permissions = { createProject:true, manageWorkspace:user.workspaceRole === 'admin' };
    value.projects = value.projects.map(project => ({ ...project, permissions:permissions(workspace.state(project.id),user), members:project.members.map(member => ({...member,...identity.member(project.id,member.id)})) }));
    return value;
  }
  function access(requestedId, user, { manage = false, write = false } = {}) {
    const state = workspace.state(requestedId);
    if (!authRequired) return { state, projectId:state.project.id, actorId:null, permissions:{manageProject:true,createTask:true,readOnly:false} };
    if (!canRead(state,user)) throw new AppError('没有访问该项目的权限',403);
    const p = permissions(state,user);
    if (manage && !p.manageProject) throw new AppError('请由项目管理者进行此操作',403);
    if (write && p.readOnly) throw new AppError('当前账号只有项目只读权限',403);
    return { state, projectId:state.project.id, actorId:identity.membership(state.project.id,user.personId)?.memberId || null, permissions:p };
  }
  function actingInput(input, context) {
    if (!authRequired) return input;
    if ('actorId' in input) throw new AppError('操作身份由登录账号确定，请勿指定其他成员',403);
    if (!context.actorId) throw new AppError('当前账号尚未加入本项目',403);
    return { ...input,actorId:context.actorId };
  }
  function authorizedState(context) {
    if (!authRequired) return context.state;
    return { ...context.state, members:context.state.members.map(member => ({...member,
      accessRole:member.id === context.actorId && context.permissions.manageProject ? 'admin' : identity.member(context.projectId,member.id)?.accessRole || 'viewer'})) };
  }
  function saveState(projectId,next,bindings) {
    const clean = {...next,members:next.members.map(member => { const {personId,accountLinked,accessRole,...value} = member; return value; })};
    workspace.save(projectId,clean);
    if (identity) identity.syncProject(clean,bindings);
    return clean;
  }
  function joinProject(projectId,person) {
    const current = workspace.state(projectId);
    if (current.members.length >= 32) throw new AppError('项目最多支持 32 名成员');
    const memberId = `member-${randomUUID()}`;
    const next = structuredClone(current);
    next.members.push({id:memberId,name:person.name,role:'项目协作者',color:person.color,initial:person.initial});
    next.activities.unshift({id:`event-${randomUUID()}`,actorId:memberId,taskId:'',kind:'member',text:`${person.name}接受邀请加入项目。`,createdAt:new Date().toISOString()});
    next.revision += 1;
    // Identity.claim owns the surrounding SQLite transaction and adds the mapping itself.
    workspace.save(projectId,next);
    return memberId;
  }
  function ensureAdministratorMemberships(user) {
    if (!identity || user.workspaceRole !== 'admin') return;
    for (const state of workspace.allStates()) {
      const existing = identity.membership(state.project.id,user.personId);
      if (existing && state.members.some(member => member.id === existing.memberId)) continue;
      const next = structuredClone(state), person = identity.person(user.personId), memberId = existing?.memberId || `manager-${randomUUID()}`;
      next.members.push({id:memberId,name:person.name,role:'工作区管理员',color:person.color,initial:person.initial});
      next.activities.unshift({id:`event-${randomUUID()}`,actorId:memberId,taskId:'',kind:'member',text:`工作区管理员${person.name}加入项目管理。`,createdAt:new Date().toISOString()});
      next.revision += 1;
      saveState(state.project.id,next,new Map([[memberId,{personId:user.personId,accessRole:'admin'}]]));
    }
  }
  function visiblePerson(personId,user) {
    const person = identity.person(personId);
    if (user.workspaceRole !== 'admin' && personId !== user.personId && !visibleStates(user).some(state => state.members.some(member => identity.member(state.project.id,member.id)?.personId === personId))) throw new AppError('没有找到这个成员档案',404);
    return person;
  }
  function createProject(input,user) {
    if (!authRequired) return workspace.create(input);
    const allowed = ['name','description','goal','deadline','ownerName','ownerRole','ownerPersonId','color','members'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new AppError('包含不支持的项目字段');
    const ownerId = input.ownerPersonId ?? user.personId;
    if (typeof ownerId !== 'string') throw new AppError('发起人档案不正确');
    if (ownerId !== user.personId && user.workspaceRole !== 'admin') throw new AppError('请以自己的账号发起项目',403);
    const owner = visiblePerson(ownerId,user);
    if (input.members !== undefined && !Array.isArray(input.members)) throw new AppError('初始成员格式不正确');
    const bindings = new Map([['m0',{personId:owner.id,accessRole:'admin'}]]), seen = new Set([owner.id]);
    const members = (input.members || []).map((member,index) => {
      if (!plainObject(member) || Object.keys(member).some(key => !['name','personId','role'].includes(key))) throw new AppError('初始成员格式不正确');
      if ('personId' in member) {
        const person = visiblePerson(member.personId,user);
        if (seen.has(person.id)) throw new AppError('同一人员不能重复加入项目');
        seen.add(person.id); bindings.set(`m${index+1}`,{personId:person.id,accessRole:'member'});
        return {name:person.name,role:member.role};
      }
      return {name:member.name,role:member.role};
    });
    const {ownerPersonId,ownerName,...fields} = input;
    const result = workspace.create({...fields,ownerName:owner.name,members},{allowDuplicateNames:true,decorate(state) {
      let actorId = [...bindings].find(([,binding]) => binding.personId === user.personId)?.[0];
      if (!actorId) {
        if (state.members.length >= 32) throw new AppError('请为项目发起管理者保留一个成员位置');
        const person = identity.person(user.personId); actorId = `manager-${randomUUID()}`;
        state.members.push({id:actorId,name:person.name,role:'项目管理员',color:person.color,initial:person.initial});
        bindings.set(actorId,{personId:user.personId,accessRole:'admin'});
      }
      state.activities[0].actorId = actorId;
    }});
    identity.syncProject(result.state,bindings);
    return {state:decoratedState(result.state,user),workspace:workspaceView(user)};
  }

  const server = http.createServer(async (req,res) => {
    try {
      const host = req.headers.host || '';
      if (!localHost.test(host) && host !== deployment?.host) throw new AppError('不支持的访问地址',403);
      const origin = host === deployment?.host ? deployment.origin : `http://${host}`;
      if (req.headers.origin && req.headers.origin !== origin) throw new AppError('不允许来自其他网站的请求',403);
      const url = new URL(req.url,origin);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new AppError('请求路径格式不正确'); }
      const queryProjectId = () => { const ids = url.searchParams.getAll('projectId'); if (ids.length > 1) throw new AppError('请只指定一个项目'); return ids.length ? ids[0] : undefined; };
      const token = cookieToken(req);
      let currentUser = identity?.sessionUser(token) || null;
      if (req.method === 'GET' && pathname === '/api/health') return send(res,200,authRequired ? {ok:true,app:'cobuild',authRequired:true} : {ok:true,app:'cobuild',mode:'local-rules',revision:workspace.state(queryProjectId()).revision,workspaceRevision:revision()});
      if (req.method === 'GET' && pathname === '/api/auth/session') return send(res,200,sessionView(currentUser));
      if (req.method === 'POST' && pathname.startsWith('/api/auth/')) {
        if (!identity) throw new AppError('测试兼容模式不提供账号接口',404);
        const input = await body(req);
        if (pathname === '/api/auth/logout') { identity.logout(token); return send(res,200,sessionView(null),undefined,{'Set-Cookie':sessionCookie('',true)}); }
        let result;
        if (pathname === '/api/auth/setup') {
          if (remoteDeployment || setupToken) {
            if (!setupToken) throw new AppError('请先配置工作区初始化口令',503);
            const digest = value => createHash('sha256').update(value).digest();
            if (typeof input.setupToken !== 'string' || input.setupToken.length > 1024 || !timingSafeEqual(digest(input.setupToken),digest(setupToken))) throw new AppError('工作区初始化口令不正确',403);
          }
          result = await identity.setup(input);
          ensureAdministratorMemberships(result.user);
        } else if (pathname === '/api/auth/login') result = await identity.login(input,req.socket.remoteAddress || 'unknown');
        else if (pathname === '/api/auth/register') result = await identity.register(input,joinProject);
        else throw new AppError('没有这个接口',404);
        return send(res,200,{...sessionView(result.user),...(result.projectId ? {projectId:result.projectId} : {})},undefined,{'Set-Cookie':sessionCookie(result.token)});
      }
      if (req.method === 'GET' && pathname === '/api/invitations/resolve') {
        if (!identity) throw new AppError('测试兼容模式不提供邀请接口',404);
        const invitation = identity.resolveInvitation(url.searchParams.get('token'));
        const state = workspace.state(invitation.projectId);
        const person = invitation.personId ? identity.person(invitation.personId) : null;
        return send(res,200,{invitation:{id:invitation.id,email:invitation.email,accessRole:invitation.accessRole,expiresAt:invitation.expiresAt},project:{id:state.project.id,name:state.project.name,color:state.project.color || state.members[0]?.color},person:person ? {id:person.id,name:person.name,accountLinked:person.accountLinked} : null});
      }
      if (pathname.startsWith('/api/')) {
        if (authRequired && !currentUser) throw new AppError('请先登录工作区',401);
        if (currentUser) ensureAdministratorMemberships(currentUser);
      }
      if (req.method === 'GET' && pathname === '/api/workspace') return send(res,200,workspaceView(currentUser));
      if (req.method === 'GET' && pathname === '/api/dashboard') {
        const queries = url.searchParams.getAll('q');
        if (queries.length > 1) throw new AppError('请只指定一个搜索内容');
        return send(res,200,{revision:revision(),...dashboardSummary(identity,visibleStates(currentUser),currentUser,{query:queries[0] || ''})});
      }
      if (req.method === 'GET' && pathname === '/api/people') return send(res,200,{revision:revision(),people:peopleSummary(identity,visibleStates(currentUser),currentUser)});
      if (req.method === 'GET' && /^\/api\/people\/[A-Za-z0-9_-]+$/.test(pathname)) return send(res,200,personDetails(identity,visibleStates(currentUser),currentUser,pathname.split('/').at(-1)));
      if (req.method === 'GET' && ['/api/state','/api/export','/api/report'].includes(pathname)) {
        const context = access(queryProjectId(),currentUser);
        if (pathname === '/api/state') return send(res,200,decoratedState(context.state,currentUser));
        if (pathname === '/api/export') return send(res,200,context.state,'application/json; charset=utf-8',{'Content-Disposition':'attachment; filename="cobuild-project.json"'});
        return send(res,200,projectReport(context.state),'text/markdown; charset=utf-8',{'Content-Disposition':`attachment; filename="cobuild-report.md"; filename*=UTF-8''${encodeURIComponent('共建项目进展.md')}`});
      }
      if (req.method === 'GET' && /^\/api\/files\/[a-f0-9-]+$/.test(pathname)) {
        const artifact = visibleStates(currentUser).flatMap(state => state.tasks.flatMap(task => task.artifacts || [])).find(item => item.url === pathname && item.fileName);
        if (!artifact) throw new AppError('文件不存在或没有访问权限',404);
        const filePath = join(dataDir,'files',pathname.split('/').at(-1));
        if (!existsSync(filePath)) throw new AppError('文件已不可用',404);
        return send(res,200,readFileSync(filePath),'application/octet-stream',{'Content-Disposition':`attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(String(artifact.fileName).toWellFormed())}`});
      }
      if (req.method === 'POST' && pathname === '/api/projects') return send(res,201,createProject(await body(req),currentUser));
      if (req.method === 'POST' && pathname === '/api/project-members') {
        const input = await body(req), context = access(input.projectId,currentUser,{manage:true});
        if (!identity) throw new AppError('请使用真实账号模式添加已有人员');
        const person = visiblePerson(input.personId,currentUser), role = validRole(input.accessRole);
        if (identity.membership(context.projectId,person.id)) throw new AppError('该人员已经是项目成员',409);
        const action = actingInput({...input,type:'addMember',name:person.name,role:input.role},context);
        const next = applyAction(context.state,action,{manageProject:true,allowDuplicateNames:true});
        saveState(context.projectId,next,new Map([[next.members.at(-1).id,{personId:person.id,accessRole:role}]]));
        return send(res,200,{state:decoratedState(next,currentUser),workspace:workspaceView(currentUser)});
      }
      if (req.method === 'GET' && pathname === '/api/invitations') {
        const context = access(queryProjectId(),currentUser,{manage:true});
        return send(res,200,{revision:revision(),invitations:identity.invitations(context.projectId)});
      }
      if (req.method === 'POST' && pathname === '/api/invitations') {
        const input = await body(req), context = access(input.projectId,currentUser,{manage:true});
        const invitation = identity.invite({...input,projectId:context.projectId},currentUser);
        const {token:inviteToken,...value} = invitation;
        return send(res,201,{invitation:{...value,url:`${deployment?.origin || origin}/invite/${inviteToken}`}});
      }
      if (req.method === 'POST' && pathname === '/api/invitations/revoke') {
        const input = await body(req), invitation = identity.invitation(input.id);
        access(invitation.projectId,currentUser,{manage:true});
        return send(res,200,{invitation:identity.revoke(input.id)});
      }
      if (req.method === 'POST' && pathname === '/api/invitations/accept') {
        const input = await body(req), accepted = identity.accept(input.token,currentUser,joinProject);
        currentUser = accepted.user;
        return send(res,200,{state:decoratedState(workspace.state(accepted.projectId),currentUser),workspace:workspaceView(currentUser),session:sessionView(currentUser),invitation:accepted.invitation});
      }
      if (req.method === 'GET' && pathname === '/api/ai/status') {
        if (authRequired && currentUser.workspaceRole !== 'admin') throw new AppError('请由工作区管理员查看模型配置',403);
        return send(res,200,{...aiStatus(),limits:aiRequests.limits});
      }
      if (req.method === 'POST' && ['/api/ai/plan','/api/ai/replan','/api/plans/apply','/api/plans/preview','/api/plans/replan','/api/milestones/action'].includes(pathname)) {
        const input = await body(req), context = access(input.projectId,currentUser,{manage:true}), action = actingInput(input,context);
        if (pathname === '/api/ai/plan' || pathname === '/api/ai/replan') {
          const {actorId,...request} = action;
          const generate = pathname === '/api/ai/replan' ? generateReplan : generatePlan;
          const release = aiRequests.acquire(currentUser?.id || 'isolated-legacy-test');
          try { return send(res,200,await generate(authorizedState(context),request)); }
          finally { release(); }
        }
        if (pathname === '/api/plans/preview') return send(res,200,previewReplan(authorizedState(context),action));
        const apply = pathname === '/api/plans/apply' ? applyPlanDraft : pathname === '/api/plans/replan' ? applyReplanDraft : applyMilestoneAction;
        const next = apply(authorizedState(context),action);
        const saved = saveState(context.projectId,next);
        return send(res,200,{state:decoratedState(saved,currentUser)});
      }
      if (req.method === 'POST' && pathname === '/api/analyze') {
        const input = await body(req), context = access(input.projectId,currentUser), action = actingInput(input,context);
        return send(res,200,{analysis:analyzeUpdate(context.state,action)});
      }
      if (req.method === 'POST' && pathname === '/api/action') {
        const input = await body(req), context = access(input.projectId,currentUser,{write:true}), action = actingInput(input,context);
        if (authRequired && ['addMember','updateProject'].includes(action.type) && !context.permissions.manageProject) throw new AppError('请由项目管理者进行此操作',403);
        let filePath;
        try {
          if (action.type === 'submitArtifact' && action.file) {
            const file = action.file;
            if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 200 || !file.name.isWellFormed() || /[\u0000-\u001f\u007f]/.test(file.name) || typeof file.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64) || file.base64.length > 7*1024*1024) throw new AppError('文件格式不正确');
            const content = Buffer.from(file.base64,'base64');
            if (!content.length || content.length > 5*1024*1024) throw new AppError('请选择非空且小于 5MB 的文件');
            if (content.toString('base64') !== file.base64) throw new AppError('文件编码不完整，请重新选择文件');
            const fileId = randomUUID(); filePath = join(dataDir,'files',fileId);
            action.url = `/api/files/${fileId}`; action.fileMeta = {name:basename(file.name).replace(/[\r\n]/g,''),size:content.length};
            const next = reconcileMilestones(applyAction(context.state,action,authRequired ? {manageProject:context.permissions.manageProject} : {}));
            writeFileSync(filePath,content,{mode:0o600}); saveState(context.projectId,next);
          } else {
            delete action.fileMeta;
            if (action.type === 'submitArtifact' && typeof action.url === 'string' && action.url.startsWith('/api/')) throw new AppError('请通过文件选择器上传本地文件');
            const next = reconcileMilestones(applyAction(context.state,action,authRequired ? {manageProject:context.permissions.manageProject} : {}));
            saveState(context.projectId,next);
          }
          return send(res,200,{state:decoratedState(workspace.state(context.projectId),currentUser)});
        } catch (error) { if (filePath && existsSync(filePath)) unlinkSync(filePath); throw error; }
      }
      if (req.method === 'POST' && pathname === '/api/reset') {
        if (authRequired) throw new AppError('正式工作区不提供清空项目接口',403);
        const input = await body(req), context = access(input.projectId,currentUser,{manage:true});
        actingInput(input,context);
        const next = workspace.reset(context.projectId,{preserveProject:authRequired});
        if (identity) identity.syncProject(next);
        return send(res,200,{state:decoratedState(next,currentUser)});
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError('不支持的请求方式',405);
      if (pathname.startsWith('/api/')) throw new AppError('没有这个接口',404);
      const relative = pathname === '/' || pagePath.test(pathname) ? 'index.html' : pathname.slice(1);
      const publicDir = resolve(ROOT,'public'), file = resolve(publicDir,relative);
      if (!file.startsWith(`${publicDir}/`) || !existsSync(file) || !statSync(file).isFile()) throw new AppError('页面或文件不存在',404);
      send(res,200,req.method === 'HEAD' ? '' : readFileSync(file),TYPES[extname(file)] || 'application/octet-stream',{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    } catch (error) { send(res,error.status || 500,{error:error.status ? error.message : '服务处理失败，请查看服务日志'},undefined,error.retryAfter ? {'Retry-After':String(error.retryAfter)} : {}); if (!error.status) process.stderr.write(`${error.stack}\n`); }
  });
  server.on('close',() => identity?.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const readArg = (flag,fallback) => args.includes(flag) ? args[args.indexOf(flag)+1] : fallback;
  const port = Number(readArg('--port',process.env.COBUILD_PORT || '4173'));
  const host = readArg('--host','127.0.0.1');
  validateServerConfig({port,host,publicUrl:process.env.COBUILD_PUBLIC_URL || ''});
  const server = createApp();
  server.on('error',error => { process.stderr.write(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请指定其他端口。\n` : `${error.message}\n`); process.exitCode = 1; });
  server.listen(port,host,() => process.stdout.write(`共建 · 账号协作版\nLocal: http://127.0.0.1:${port}\n数据保存在 ${process.env.COBUILD_DATA_DIR || join(ROOT,'.local')}\n工作区需要登录；未配置模型时AI规划明确不可用。\n`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => server.close(() => process.exit(0)));
}
