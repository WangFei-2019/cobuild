import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));
function run(values, production = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COBUILD_')));
  const result = spawnSync(process.execPath, [script, '--json', ...(production ? ['--production'] : [])], {env:{...env,...values}, encoding:'utf8'});
  return {...result, report:JSON.parse(result.stdout)};
}

test('只读部署预检不初始化或改写数据，不联网且不输出凭证', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cobuild-doctor-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  writeFileSync(join(dir,'existing-data.json'), '{"preserve":true}\n');
  const key = 'doctor-test-secret-never-output';
  const result = run({COBUILD_DATA_DIR:dir, COBUILD_PUBLIC_URL:'https://example.test', COBUILD_SETUP_TOKEN:key, COBUILD_AI_API_KEY:key, COBUILD_AI_BASE_URL:'https://offline-test.invalid', COBUILD_AI_MODEL:'offline-model'}, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.report.ok, true);
  assert.ok(!result.stdout.includes(key));
  assert.deepEqual(readdirSync(dir), ['existing-data.json']);
  assert.equal(readFileSync(join(dir,'existing-data.json'),'utf8'), '{"preserve":true}\n');
});

test('生产预检拒绝缺失公开地址、明文外网地址和缺少初始化口令', () => {
  for (const settings of [{}, {COBUILD_PUBLIC_URL:'http://example.test'}, {COBUILD_PUBLIC_URL:'https://example.test'}]) {
    const result = run(settings, true);
    assert.equal(result.status, 1);
    assert.equal(result.report.ok, false);
    assert.ok(result.report.checks.some(item => item.level === 'error'));
  }
});

test('空的可选模型secret文件允许手动协作，无效模型配置会被报告', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cobuild-doctor-secret-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const secret = join(dir,'empty-key'); writeFileSync(secret, '');
  const empty = run({COBUILD_AI_API_KEY_FILE:secret});
  assert.equal(empty.status, 0, empty.stdout);
  assert.equal(empty.report.checks.find(item => item.name === 'ai').level, 'info');
  const incomplete = run({COBUILD_AI_MODEL:'configured-without-provider'});
  assert.equal(incomplete.status, 1);
  assert.equal(incomplete.report.checks.find(item => item.name === 'ai').level, 'error');
});

test('预检读取secret内容，拒绝空白初始化口令及不可读/多行凭证，不泄露内容', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cobuild-doctor-content-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const token = join(dir, 'setup'); writeFileSync(token, ' \n\t');
  const whitespace = run({COBUILD_PUBLIC_URL:'https://example.test', COBUILD_SETUP_TOKEN_FILE:token}, true);
  assert.equal(whitespace.status, 1);
  assert.match(whitespace.report.checks.find(item => item.name === 'secrets').message, /空白/);
  const secret = 'only-private-setup-value'; writeFileSync(token, secret + '\n');
  const valid = run({COBUILD_PUBLIC_URL:'https://example.test', COBUILD_DOMAIN:'example.test', COBUILD_SETUP_TOKEN_FILE:token}, true);
  assert.equal(valid.status, 0, valid.stdout);
  assert.ok(!valid.stdout.includes(secret));
  for (const value of [{COBUILD_SETUP_TOKEN_FILE:join(dir,'missing')}, {COBUILD_AI_API_KEY:'private-first\nprivate-second'}]) {
    const invalid = run(value);
    assert.equal(invalid.status, 1);
    assert.ok(!invalid.stdout.includes('private-first'));
  }
});

test('预检校验代理域名与公开地址，按实际PORT优先级检查端口', () => {
  const base = {COBUILD_PUBLIC_URL:'https://example.test', COBUILD_SETUP_TOKEN:'private-setup'};
  const mismatch = run({...base, COBUILD_DOMAIN:'different.test'}, true);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.report.checks.find(item => item.name === 'server').message, /一致/);
  const port = run({...base, COBUILD_DOMAIN:'EXAMPLE.test', PORT:'10000'}, true);
  assert.equal(port.status, 0, port.stdout);
  assert.match(port.report.checks.find(item => item.name === 'port').message, /10000/);
  const precedence = run({...base, PORT:'10000', COBUILD_PORT:'4500'}, true);
  assert.match(precedence.report.checks.find(item => item.name === 'port').message, /4500/);
  assert.equal(run({...base, PORT:'not-a-port'}, true).status, 1);
});

test('邮件配置预检只核对本地字段，不泄露凭证，缺字段明确报错', () => {
  const secret='mail-fixture-never-output';
  const valid=run({COBUILD_PUBLIC_URL:'https://example.test',COBUILD_MAIL_API_KEY:secret,COBUILD_MAIL_FROM:'accounts@example.test'});
  assert.equal(valid.status,0,valid.stdout);
  assert.equal(valid.report.checks.find(item=>item.name==='mail').level,'ok');
  assert.ok(!valid.stdout.includes(secret));
  for(const config of [{COBUILD_MAIL_API_KEY:secret},{COBUILD_MAIL_FROM:'accounts@example.test'},{COBUILD_MAIL_API_KEY:secret,COBUILD_MAIL_FROM:'accounts@example.test',COBUILD_PUBLIC_URL:'https://example.test',COBUILD_MAIL_API_URL:'http://external.example/send'}]){
    const invalid=run(config);assert.equal(invalid.status,1,invalid.stdout);
    assert.equal(invalid.report.checks.find(item=>item.name==='mail').level,'error');
    assert.ok(!invalid.stdout.includes(secret));
  }
  const empty=run({});assert.equal(empty.report.checks.find(item=>item.name==='mail').level,'info');
});
