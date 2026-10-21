import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
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

test('release archive extracts to exactly the verified allowlist without platform metadata sidecars',t=>{
  const {source,output,base}=fixture(t),archive=join(base,'release.tar.gz'),extracted=join(base,'extracted');
  packageRelease({source,output,archive});
  mkdirSync(extracted);
  const result=spawnSync('tar',['-xzf',archive,'-C',extracted],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(verifyRelease(extracted).ok,true);
});

test('release packaging and verification CLIs actually execute through a current-version directory symlink',t=>{
  const {base}=fixture(t),alias=join(base,'current'),output=join(base,'actual-package');
  symlinkSync(fileURLToPath(new URL('../',import.meta.url)),alias,'dir');
  const pack=spawnSync(process.execPath,[join(alias,'scripts/package-release.mjs'),'--out',output],{encoding:'utf8'});
  assert.equal(pack.status,0,pack.stderr);
  assert.equal(JSON.parse(pack.stdout).directory,realpathSync(output));
  const verify=spawnSync(process.execPath,[join(alias,'scripts/verify-release.mjs'),output],{encoding:'utf8'});
  assert.equal(verify.status,0,verify.stderr);
  assert.equal(JSON.parse(verify.stdout).ok,true);
  const invalid=spawnSync(process.execPath,[join(alias,'scripts/verify-release.mjs'),output,'unexpected'],{encoding:'utf8'});
  assert.equal(invalid.status,1);
  assert.match(invalid.stderr,/用法/);
});

test('runtime and operations modules remain importable from stdin without executing their CLI',()=>{
  const modules=['server.mjs','scripts/backup.mjs','scripts/package-release.mjs','scripts/verify-release.mjs'];
  const source=modules.map(file=>'await import('+JSON.stringify(new URL('../'+file,import.meta.url).href)+');').join('\n')+'\nconsole.log("modules-imported");';
  const result=spawnSync(process.execPath,['--input-type=module','-'],{input:source,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),'modules-imported');
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

test('Pages service entry and explicit demo use relative URLs versioned by their actual assets',()=>{
  const root = fileURLToPath(new URL('../',import.meta.url));
  const build = spawnSync(process.execPath,['scripts/build-pages.mjs'],{cwd:root,encoding:'utf8'});
  assert.equal(build.status,0,build.stderr);
  for(const [file,stem] of [['index.html','entry'],['demo.html','app']]){
   const html = readFileSync(join(root,'dist-pages',file),'utf8');
   for (const [extension,attribute] of [['js','src'],['css','href']]) {
    const hash = createHash('sha256').update(readFileSync(join(root,'dist-pages',stem+'.'+extension))).digest('hex').slice(0,12);
    assert.ok(html.includes(attribute + '="./'+stem+'.'+extension+'?v='+hash+'"'),file+': '+extension+' URL must match its content digest');
   }
   assert.ok(!html.includes('src="/app.js"') && !html.includes('href="/app.css"'));
  }
  assert.match(readFileSync(join(root,'dist-pages/index.html'),'utf8'),/进入工作区/);
  assert.match(readFileSync(join(root,'dist-pages/demo.html'),'utf8'),/交互演示/);
  assert.ok(!readFileSync(join(root,'dist-pages/entry.js'),'utf8').includes('cobuild.demo.state'));
});
