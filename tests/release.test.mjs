import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {packageRelease} from '../scripts/package-release.mjs';
import {verifyRelease} from '../scripts/verify-release.mjs';
import {isReleaseFile, REQUIRED_RELEASE_FILES} from '../scripts/release-manifest.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(),'cobuild-release-test-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const source = join(base,'source');
  for (const path of REQUIRED_RELEASE_FILES) {
    mkdirSync(dirname(join(source,path)),{recursive:true});
    writeFileSync(join(source,path),path === 'package.json' ? JSON.stringify({name:'cobuild',version:'0.2.0',engines:{node:'>=24'},packageManager:'pnpm@11.25.0'}) : 'fixture: ' + path);
  }
  return {base, source, output:join(base,'release')};
}

test('release contains standalone project and all root backend modules; private or parent data is excluded',t=>{
  const {source,output,base} = fixture(t);
  for (const path of ['.local/project.json','.secrets/ai_api_key','node_modules/pkg/index.js','screenshots/private.png','.git/config','.env','notes.md','public/private.json']) {
    mkdirSync(dirname(join(source,path)),{recursive:true});
    writeFileSync(join(source,path),'must stay private');
  }
  writeFileSync(join(base,'another-project.txt'),'parent project');
  writeFileSync(join(source,'future-module.mjs'),'export const okay = true;');
  const result = packageRelease({source,output});
  assert.equal(result.version,'0.2.0');
  const manifest = JSON.parse(readFileSync(join(output,'RELEASE-MANIFEST.json'),'utf8'));
  assert.ok(manifest.files.some(file=>file.path === 'future-module.mjs'));
  assert.ok(manifest.files.some(file=>file.path === '.github/workflows/ci.yml'));
  assert.ok(!manifest.files.some(file=>/local|secret|another-project|private|notes/.test(file.path)));
  assert.equal(verifyRelease(output).ok,true);
});

test('integrity verification rejects changed contents and unlisted private files',t=>{
  const {source,output} = fixture(t);
  packageRelease({source,output});
  writeFileSync(join(output,'server.mjs'),'tampered');
  assert.throws(()=>verifyRelease(output),/内容与发布清单/);
  writeFileSync(join(output,'server.mjs'),'fixture: server.mjs');
  writeFileSync(join(output,'.env'),'private value');
  assert.throws(()=>verifyRelease(output),/未列入清单/);
});

test('packager refuses overwrites, nested paths, symlinked files and recognisable credentials',t=>{
  const {source,output,base} = fixture(t);
  assert.throws(()=>packageRelease({source,output:source}),/之外/);
  assert.throws(()=>packageRelease({source,output:join(source,'..hidden')}),/之外/);
  assert.throws(()=>packageRelease({source,output:base}),/包含源码/);
  assert.throws(()=>packageRelease({source,output,archive:join(source,'release.tar.gz')}),/源码与发布目录之外/);
  const sourceAlias = join(base,'source-alias');
  symlinkSync(source,sourceAlias);
  assert.throws(()=>packageRelease({source,output:join(sourceAlias,'nested-output')}),/之外/);
  const modulePath = join(source,'unsafe.mjs');
  symlinkSync(join(base,'another-file'),modulePath);
  assert.throws(()=>packageRelease({source,output}),/普通文件/);
  rmSync(modulePath);
  writeFileSync(modulePath,'fixture credential: ' + 'ghp_' + 'a'.repeat(36));
  assert.throws(()=>packageRelease({source,output}),/疑似凭据/);
  rmSync(modulePath);
  packageRelease({source,output});
  assert.throws(()=>packageRelease({source,output}),/拒绝覆盖/);
});

test('release paths reject traversal, hidden state and env files while allowing checked-in examples',()=>{
  for (const path of ['../server.mjs','src/../.env','src/.private.js','public/.local/key','/server.mjs','.env','.env.production','.secrets/key','identity.sqlite','src\\main.jsx']) assert.equal(isReleaseFile(path),false,path);
  for (const path of ['.env.example','server.mjs','dashboard.mjs','src/main.jsx','scripts/doctor.mjs','.github/workflows/ci.yml']) assert.equal(isReleaseFile(path),true,path);
});
