import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectReleaseFiles, listAllFiles, MANIFEST_NAME} from './release-manifest.mjs';

export function verifyRelease(root) {
  const base = resolve(root);
  const manifest = JSON.parse(readFileSync(join(base,MANIFEST_NAME),'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files)) throw new Error('发布清单格式无效');
  const expected = manifest.files.map(file => file.path);
  if (new Set(expected).size !== expected.length) throw new Error('发布清单含重复路径');
  const actual = listAllFiles(base);
  const permitted = new Set([...expected,MANIFEST_NAME]);
  for (const path of actual) if (!permitted.has(path)) throw new Error('发布目录含未列入清单的文件：' + path);
  const collected = collectReleaseFiles(base);
  if (collected.length !== manifest.files.length) throw new Error('发布文件数量与清单不一致');
  for (const file of collected) {
    const record = manifest.files.find(item => item.path === file.path);
    if (!record || record.sha256 !== file.sha256 || record.size !== file.size) throw new Error('文件内容与发布清单不一致：' + file.path);
  }
  const meta = JSON.parse(readFileSync(join(base,'package.json'),'utf8'));
  if (meta.name !== manifest.name || meta.version !== manifest.version || meta.engines.node !== manifest.node) throw new Error('包版本与清单不一致');
  return {ok:true, files:collected.length, version:meta.version};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1) throw new Error('用法：node scripts/verify-release.mjs /发布目录');
    console.log(JSON.stringify(verifyRelease(args[0] || resolve(dirname(fileURLToPath(import.meta.url)),'..')),null,2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
