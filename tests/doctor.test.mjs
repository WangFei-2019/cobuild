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
