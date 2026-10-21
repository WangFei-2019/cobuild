import {mkdirSync, existsSync, readFileSync, copyFileSync, writeFileSync, realpathSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {collectReleaseFiles, MANIFEST_NAME} from './release-manifest.mjs';
import {verifyRelease} from './verify-release.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inside = (base,path) => {
  const child = relative(base,path);
  return !child || !(child === '..' || child.startsWith('..' + sep) || isAbsolute(child));
};
function canonical(path) {
  let existing = resolve(path);
  const missing = [];
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) throw new Error('无法解析发布路径');
    existing = parent;
  }
  return join(realpathSync(existing),...missing);
}

export function packageRelease({source = sourceRoot, output, archive} = {}) {
  const root = realpathSync(resolve(source));
  if (!output) throw new Error('用法：node scripts/package-release.mjs --out /绝对路径/cobuild-release [--archive /绝对路径/cobuild.tar.gz]');
  const target = canonical(output);
  if (inside(root,target)) throw new Error('发布目录必须位于源码目录之外');
  if (inside(target,root)) throw new Error('发布目录不能包含源码目录');
  if (existsSync(target)) throw new Error('发布目录已存在，拒绝覆盖：' + target);
  const archivePath = archive ? canonical(archive) : null;
  if (archivePath && (existsSync(archivePath) || inside(target,archivePath) || inside(root,archivePath))) throw new Error('归档必须是源码与发布目录之外的新文件');
  const files = collectReleaseFiles(root);
  const meta = JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  mkdirSync(target,{recursive:true});
  for (const file of files) {
    const location = join(target,file.path);
    mkdirSync(dirname(location),{recursive:true});
    copyFileSync(join(root,file.path),location);
  }
  const manifest = {format:1, name:meta.name, version:meta.version, node:meta.engines.node, files};
  if (/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')) manifest.sourceCommit = process.env.GITHUB_SHA;
  writeFileSync(join(target,MANIFEST_NAME),JSON.stringify(manifest,null,2) + '\n');
  verifyRelease(target);
  if (archivePath) {
    mkdirSync(dirname(archivePath),{recursive:true});
    // macOS otherwise adds AppleDouble/xattr sidecar files outside the allowlist.
    const result = spawnSync('tar',['--no-xattrs','-czf',archivePath,'-C',target,'.'],{stdio:'inherit',env:{...process.env,COPYFILE_DISABLE:'1'}});
    if (result.error || result.status !== 0) throw new Error('归档失败；已生成的目录仍可用于独立仓库');
  }
  return {directory:target, archive:archivePath, files:files.length, version:meta.version};
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i=0;i<args.length;i+=2) {
      if (!['--out','--archive'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw new Error('仅支持 --out 与可选 --archive');
      const key = args[i] === '--out' ? 'output' : 'archive';
      if (options[key]) throw new Error('参数不能重复：' + args[i]);
      options[key] = args[i+1];
    }
    console.log(JSON.stringify(packageRelease(options),null,2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
