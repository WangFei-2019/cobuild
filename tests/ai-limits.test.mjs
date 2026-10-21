import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const configKeys = ['COBUILD_AI_BASE_URL', 'COBUILD_AI_API_KEY', 'COBUILD_AI_MODEL', 'COBUILD_AI_TIMEOUT_MS',
  'COBUILD_AI_MAX_TOKENS', 'COBUILD_AI_RESPONSE_FORMAT', 'COBUILD_AI_TOKEN_PARAMETER', 'COBUILD_AI_THINKING',
  'COBUILD_AI_RATE_LIMIT', 'COBUILD_AI_RATE_WINDOW_SECONDS'];
const password = 'fixture-password-limits-2026';
async function fixture(t, { calls = 10, seconds = 600, slow = false } = {}) {
  const previous = new Map(configKeys.map(key => [key, process.env[key]]));
  for (const key of configKeys) delete process.env[key];
  const dataDir = mkdtempSync(join(tmpdir(), 'cobuild-ai-limits-')), servers = [], requests = [], waiters = [];
  const finish = response => { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{"error":"fixture only"}'); };
  const model = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the bounded fixture request. */ }
    requests.push(response); for (const waiter of waiters) waiter();
    if (!slow) finish(response);
  });
  const listen = async server => { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
  const modelBase = await listen(model);
  Object.assign(process.env, { COBUILD_AI_BASE_URL: `${modelBase}/v1`, COBUILD_AI_API_KEY: 'limits-fixture-only',
    COBUILD_AI_MODEL: 'limits-fixture', COBUILD_AI_TIMEOUT_MS: '3000', COBUILD_AI_RATE_LIMIT: String(calls), COBUILD_AI_RATE_WINDOW_SECONDS: String(seconds) });
  const base = await listen(createApp({ dataDir, publicUrl: '', setupToken: '' }));
  t.after(async () => {
    for (const response of requests) if (!response.writableEnded) finish(response);
    for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(dataDir, { recursive: true, force: true });
  });
  function client() {
    let cookie = '';
    return async (path, body) => {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
        ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
  }
  const admin = client();
  assert.equal((await admin('/api/auth/setup', { name: '限流测试管理员', email: 'limits-admin@example.test', password })).status, 200);
  const invite = async index => {
    const email = `limits-${index}@example.test`, guest = client();
    const invitation = await admin('/api/invitations', { projectId: 'p1', email, accessRole: 'admin' });
    const inviteToken = new URL(invitation.body.invitation.url).pathname.split('/').at(-1);
    assert.equal((await guest('/api/auth/register', { name: `参与者${index}`, email, password, inviteToken })).status, 200);
    return guest;
  };
  const waitFor = count => requests.length >= count ? Promise.resolve() : new Promise(resolve => {
    const check = () => { if (requests.length >= count) resolve(); }; waiters.push(check);
  });
  return { admin, invite, requests, waitFor, release: () => requests.forEach(response => { if (!response.writableEnded) finish(response); }) };
}

const input = { projectId: 'p1', goal: '只验证并发限制，不调用外部模型' };
test('默认真实账号的plan/replan共享每账号1和全局4并发，失败后finally释放', async t => {
  const { admin, invite, requests, waitFor, release } = await fixture(t, { slow: true });
  const guests = []; for (let i = 0; i < 4; i++) guests.push(await invite(i));
  const pending = [admin('/api/ai/plan', input)]; await waitFor(1);
  const duplicate = await admin('/api/ai/replan', input);
  assert.equal(duplicate.status, 429); assert.equal(duplicate.headers.get('retry-after'), '1');
  pending.push(...guests.slice(0, 3).map(guest => guest('/api/ai/plan', input))); await waitFor(4);
  const globalLimit = await guests[3]('/api/ai/replan', input);
  assert.equal(globalLimit.status, 429); assert.equal(globalLimit.headers.get('retry-after'), '1');
  assert.equal(requests.length, 4);
  release(); assert.deepEqual((await Promise.all(pending)).map(result => result.status), [502, 502, 502, 502]);
  const retry = admin('/api/ai/replan', input); await waitFor(5); release();
  assert.equal((await retry).status, 502, 'model failure must release both concurrency slots');
});

test('plan/replan共享可配置窗口次数、429带重试时间，窗口结束恢复且不泄露密钥', async t => {
  const { admin, requests } = await fixture(t, { calls: 2, seconds: 1 });
  const status = await admin('/api/ai/status');
  assert.deepEqual(status.body.limits, { accountConcurrency: 1, globalConcurrency: 4, accountCalls: 2, windowSeconds: 1 });
  assert.ok(!JSON.stringify(status.body).includes('limits-fixture-only'));
  assert.equal((await admin('/api/ai/plan', input)).status, 502);
  assert.equal((await admin('/api/ai/replan', input)).status, 502);
  const limited = await admin('/api/ai/plan', input);
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '1'); assert.equal(requests.length, 2);
  await delay(1050);
  assert.equal((await admin('/api/ai/plan', input)).status, 502);
  assert.equal(requests.length, 3);
});
