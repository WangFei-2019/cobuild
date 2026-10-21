import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createIdentity} from '../identity.mjs';
import {backupData, restoreData, verifyBackup} from '../scripts/backup.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(),'cobuild-backup-')), source = join(base,'source'); mkdirSync(source);
  t.after(() => rmSync(base,{recursive:true,force:true}));
  writeFileSync(join(source,'workspace.json'),JSON.stringify({revision:3,projectIds:['test']}));
  return {base,source,backup:join(base,'snapshot'),restored:join(base,'restored')};
}

test('离线全量备份恢复真实账号SQLite、项目JSON、上传二进制，恢复后可登录且原数据不变', async t => {
  const {source,backup,restored} = fixture(t), identity = createIdentity(source);
  const credentials = {name:'备份验证管理员',email:'backup@example.test',password:'Backup-test-password-2026'};
  await identity.setup(credentials); identity.close();
  mkdirSync(join(source,'files')); writeFileSync(join(source,'files','binary'),Buffer.from([0,255,23,10]));
  writeFileSync(join(source,'project.json'),'{"preserve":"完整项目历史"}\n');
  const originalDB = readFileSync(join(source,'identity.sqlite'));
  const snapshot = backupData({dataDir:source,output:backup,offline:true});
  assert.equal(snapshot.ok,true); assert.equal(verifyBackup(backup).ok,true);
  restoreData({backupDir:backup,output:restored,offline:true});
  assert.deepEqual(readFileSync(join(restored,'identity.sqlite')),originalDB);
  assert.deepEqual(readFileSync(join(source,'identity.sqlite')),originalDB);
  assert.deepEqual(readFileSync(join(restored,'files','binary')),Buffer.from([0,255,23,10]));
  assert.equal(readFileSync(join(restored,'project.json'),'utf8'),'{"preserve":"完整项目历史"}\n');
  const recovered = createIdentity(restored); t.after(() => recovered.close());
  const login = await recovered.login(credentials,'127.0.0.1'); assert.equal(login.user.email,credentials.email);
});

test('备份/恢复必须显式offline，拒绝覆盖、互相包含、符号链接和不完整数据目录', t => {
  const {source,backup,restored,base} = fixture(t); writeFileSync(join(source,'identity.sqlite'),'fixture');
  assert.throws(() => backupData({dataDir:source,output:backup}),/offline/);
  assert.throws(() => backupData({dataDir:source,output:source,offline:true}),/已存在/);
  assert.throws(() => backupData({dataDir:source,output:join(source,'snapshot'),offline:true}),/互不包含/);
  backupData({dataDir:source,output:backup,offline:true});
  assert.throws(() => backupData({dataDir:source,output:backup,offline:true}),/已存在/);
  assert.throws(() => restoreData({backupDir:backup,output:restored}),/offline/);
  mkdirSync(restored); writeFileSync(join(restored,'keep'),'preserved');
  assert.throws(() => restoreData({backupDir:backup,output:restored,offline:true}),/已存在/);
  assert.equal(readFileSync(join(restored,'keep'),'utf8'),'preserved');
  symlinkSync(join(source,'identity.sqlite'),join(source,'linked-file'));
  assert.throws(() => backupData({dataDir:source,output:join(base,'unsafe'),offline:true}),/符号链接/);
  const empty = join(base,'empty'); mkdirSync(empty);
  assert.throws(() => backupData({dataDir:empty,output:join(base,'empty-backup'),offline:true}),/完整/);
});

test('恢复前校验SHA256、清单路径与额外文件，失败不创建输出目录', t => {
  const {source,backup,restored} = fixture(t); writeFileSync(join(source,'identity.sqlite'),'fixture');
  backupData({dataDir:source,output:backup,offline:true});
  writeFileSync(join(backup,'data','identity.sqlite'),'tampered');
  assert.throws(() => restoreData({backupDir:backup,output:restored,offline:true}),/SHA-256/);
  assert.equal(existsSync(restored),false);
  writeFileSync(join(backup,'data','identity.sqlite'),'fixture');
  const manifestFile = join(backup,'COBUILD-BACKUP.json'), manifest = JSON.parse(readFileSync(manifestFile,'utf8'));
  const original = readFileSync(manifestFile,'utf8'); manifest.files[0].path='../escape'; writeFileSync(manifestFile,JSON.stringify(manifest));
  assert.throws(() => verifyBackup(backup),/字段/); assert.equal(existsSync(restored),false);
  writeFileSync(manifestFile,original); writeFileSync(join(backup,'data','extra'),'extra');
  assert.throws(() => verifyBackup(backup),/SHA-256/);
});

test('备份CLI不打印文件正文或凭证，verify只读核对快照', t => {
  const {source,backup} = fixture(t); const secret = 'backup-private-body-never-output'; writeFileSync(join(source,'identity.sqlite'),secret);
  const script = fileURLToPath(new URL('../scripts/backup.mjs',import.meta.url));
  const created = spawnSync(process.execPath,[script,'backup','--data',source,'--out',backup,'--offline'],{encoding:'utf8'});
  assert.equal(created.status,0,created.stderr); assert.equal(JSON.parse(created.stdout).ok,true); assert.ok(!created.stdout.includes(secret));
  const before = readFileSync(join(backup,'COBUILD-BACKUP.json'),'utf8');
  const verified = spawnSync(process.execPath,[script,'verify','--backup',backup],{encoding:'utf8'});
  assert.equal(verified.status,0,verified.stderr); assert.equal(readFileSync(join(backup,'COBUILD-BACKUP.json'),'utf8'),before);
});

test('完整复制停服后仍存在的SQLite WAL/SHM附属文件，不只备份主库', t => {
  const {source,backup,restored} = fixture(t);
  const files = {'identity.sqlite':Buffer.from('main-database'), 'identity.sqlite-wal':Buffer.from([1,0,255,2]), 'identity.sqlite-shm':Buffer.from([9,8,0,7])};
  for (const [name,bytes] of Object.entries(files)) writeFileSync(join(source,name),bytes);
  backupData({dataDir:source,output:backup,offline:true}); restoreData({backupDir:backup,output:restored,offline:true});
  for (const [name,bytes] of Object.entries(files)) assert.deepEqual(readFileSync(join(restored,name)),bytes);
});


test('通过current符号链接目录启动CLI，backup/verify/restore真实执行且不泄露正文', t => {
  const {source,backup,restored,base} = fixture(t);
  const secret = 'symlink-launch-private-body-never-output';
  writeFileSync(join(source,'identity.sqlite'),secret);
  mkdirSync(join(source,'files')); const bytes = Buffer.from([0,255,4,8]); writeFileSync(join(source,'files','proof'),bytes);
  const release = join(base,'release'), scripts = join(release,'scripts'), current = join(base,'current');
  mkdirSync(scripts,{recursive:true});
  copyFileSync(fileURLToPath(new URL('../scripts/backup.mjs',import.meta.url)),join(scripts,'backup.mjs'));
  symlinkSync(release,current,'dir');
  const script = join(current,'scripts','backup.mjs');
  function run(args) {
    const result = spawnSync(process.execPath,[script,...args],{cwd:base,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    const report = JSON.parse(result.stdout); assert.equal(report.ok,true); assert.ok(report.files>=3);
    return report;
  }
  const created = run(['backup','--data',source,'--out',backup,'--offline']);
  assert.ok(existsSync(join(backup,'COBUILD-BACKUP.json')));
  const before = readFileSync(join(backup,'COBUILD-BACKUP.json'),'utf8');
  assert.deepEqual(run(['verify','--backup',backup]),created);
  assert.equal(readFileSync(join(backup,'COBUILD-BACKUP.json'),'utf8'),before);
  assert.deepEqual(run(['restore','--backup',backup,'--out',restored,'--offline']),created);
  assert.equal(readFileSync(join(restored,'identity.sqlite'),'utf8'),secret);
  assert.deepEqual(readFileSync(join(restored,'files','proof')),bytes);
  const rejected = spawnSync(process.execPath,[script,'restore','--backup',backup,'--out',restored,'--offline'],{cwd:base,encoding:'utf8'});
  assert.equal(rejected.status,1); assert.match(rejected.stderr,/拒绝覆盖/); assert.ok(!rejected.stderr.includes(secret));
});
