import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runtimeEnvironment, runtimeOptions} from '../scripts/runtime-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COBUILD_') && key !== 'PORT'));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'cobuild-start-'));
  t.after(() => rmSync(directory,{recursive:true,force:true}));
  return directory;
}

test('运行配置读取文件优先于进程值，空可选key可用且原始环境不被修改', t => {
  const dir = fixture(t), token = join(dir,'setup'), key = join(dir,'ai');
  writeFileSync(token,'file-private-token\n'); writeFileSync(key,' \n');
  const original = {COBUILD_SETUP_TOKEN:'env-value',COBUILD_SETUP_TOKEN_FILE:token,COBUILD_AI_API_KEY_FILE:key};
  const result = runtimeEnvironment(original);
  assert.equal(result.COBUILD_SETUP_TOKEN,'file-private-token'); assert.equal(result.COBUILD_AI_API_KEY,'');
  assert.equal(original.COBUILD_SETUP_TOKEN,'env-value');
  writeFileSync(token,'\n'); assert.throws(() => runtimeEnvironment(original), /空白/);
  writeFileSync(token,'x'.repeat(1025)); assert.throws(() => runtimeEnvironment(original), /格式/);
});

test('启动端口为CLI优先，其次COBUILD_PORT、PORT；域名必须匹配公开HTTPS地址', () => {
  assert.equal(runtimeOptions({PORT:'10000'}).port,10000);
  assert.equal(runtimeOptions({PORT:'10000',COBUILD_PORT:'4500'}).port,4500);
  assert.equal(runtimeOptions({PORT:'10000',COBUILD_PORT:'4500'},['--port','4567']).port,4567);
  assert.equal(runtimeOptions({}).port,4173);
  for (const args of [['--port','-1'],['--port','123','--port','456'],['--unknown','1']]) assert.throws(() => runtimeOptions({},args));
  assert.doesNotThrow(() => runtimeOptions({COBUILD_DOMAIN:'example.test',COBUILD_PUBLIC_URL:'https://example.test'}));
  for (const domain of ['other.test','https://example.test','example.test/path','example.test other.test']) assert.throws(() => runtimeOptions({COBUILD_DOMAIN:domain,COBUILD_PUBLIC_URL:'https://example.test'}),/一致/);
});

test('真实启动wrapper向子进程传入文件凭证与平台端口，不打印凭证、不启动监听服务', t => {
  const dir = fixture(t), scripts = join(dir,'scripts'); mkdirSync(scripts);
  for (const name of ['start.mjs','runtime-config.mjs']) copyFileSync(join(root,'scripts',name),join(scripts,name));
  const secret = 'local-wrapper-secret'; const token = join(dir,'secret'); writeFileSync(token, secret + '\n');
  const digest = createHash('sha256').update(secret).digest('hex');
  writeFileSync(join(dir,'server.mjs'), `import {createHash} from 'node:crypto';\nimport {fileURLToPath} from 'node:url';\nexport function validateServerConfig() {}\nif(process.argv[1]===fileURLToPath(import.meta.url)) { const at=process.argv.indexOf('--port'); const valid=createHash('sha256').update(process.env.COBUILD_SETUP_TOKEN).digest('hex')===${JSON.stringify(digest)}; console.log(JSON.stringify({valid,port:process.argv[at+1]})); }\n`);
  const result = spawnSync(process.execPath,[join(scripts,'start.mjs'),'--host','0.0.0.0'],{env:{...cleanEnv(),PORT:'10000',COBUILD_PUBLIC_URL:'https://example.test',COBUILD_SETUP_TOKEN_FILE:token},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr); assert.deepEqual(JSON.parse(result.stdout),{valid:true,port:'10000'});
  assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
});

test('启动前拒绝非法文件配置或错误域名，不创建数据目录且不泄露凭证', t => {
  const dir = fixture(t), data = join(dir,'must-not-create'), token = join(dir,'setup'); writeFileSync(token,' \n');
  for (const config of [{COBUILD_SETUP_TOKEN_FILE:token},{COBUILD_SETUP_TOKEN_FILE:join(dir,'missing')},{COBUILD_DOMAIN:'wrong.test',COBUILD_PUBLIC_URL:'https://example.test',COBUILD_SETUP_TOKEN:'do-not-print-this'}]) {
    const result = spawnSync(process.execPath,[join(root,'scripts/start.mjs')],{env:{...cleanEnv(),COBUILD_DATA_DIR:data,...config},encoding:'utf8'});
    assert.equal(result.status,1); assert.ok(!result.stdout.includes('do-not-print-this') && !result.stderr.includes('do-not-print-this'));
    assert.equal(existsSync(data),false);
  }
});

test('邮件key支持私有文件读取、空值禁用以及单行限制，不改变原环境', t => {
  const dir=fixture(t), file=join(dir,'mail');
  writeFileSync(file,'mail-fixture-credential\n');
  const input={COBUILD_MAIL_API_KEY:'old-value',COBUILD_MAIL_API_KEY_FILE:file};
  assert.equal(runtimeEnvironment(input).COBUILD_MAIL_API_KEY,'mail-fixture-credential');
  assert.equal(input.COBUILD_MAIL_API_KEY,'old-value');
  writeFileSync(file,' \n');assert.equal(runtimeEnvironment(input).COBUILD_MAIL_API_KEY,'');
  writeFileSync(file,'private-first\nprivate-second');assert.throws(()=>runtimeEnvironment(input),/格式/);
});
