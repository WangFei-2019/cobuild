import {constants, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const MANIFEST = 'COBUILD-BACKUP.json';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const inside = (base, path) => { const child = relative(base, path); return !child || !(child === '..' || child.startsWith('..' + sep) || isAbsolute(child)); };
const exists = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
function newDestination(path, source) {
  if (!path) throw new Error('需要指定不存在的输出目录。');
  const target = resolve(path);
  if (exists(target)) throw new Error('输出目录已存在，拒绝覆盖。');
  // Resolve existing ancestors so a symlink cannot turn an apparent sibling into a nested copy.
  let ancestor = target;
  const missing = [];
  while (!exists(ancestor)) { missing.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  const canonical = join(realpathSync(ancestor), ...missing);
  if (inside(source, canonical) || inside(canonical, source)) throw new Error('输入与输出目录必须互不包含。');
  if (!exists(dirname(canonical))) throw new Error('请先创建输出目录的父目录。');
  return canonical;
}
function filesIn(directory) {
  if (!statSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('数据或备份输入必须是普通目录。');
  const files = [];
  function walk(parent, prefix = '') {
    for (const item of readdirSync(parent, {withFileTypes:true})) {
      const name = prefix + item.name, path = join(parent, item.name), stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('拒绝备份或恢复符号链接及特殊文件。');
      if (stat.isDirectory()) walk(path, name + '/');
      else files.push({path:name, size:stat.size, sha256:hash(path), mode:stat.mode & 0o777});
    }
  }
  walk(directory);
  return files.sort((a,b) => a.path.localeCompare(b.path, 'en'));
}
function sameContents(expected, actual) {
  return expected.length === actual.length && expected.every((file, i) => file.path === actual[i].path && file.size === actual[i].size && file.sha256 === actual[i].sha256);
}
function copyFiles(source, target, files, rootCreated = false) {
  if (!rootCreated) mkdirSync(target, {mode:0o700});
  for (const file of files) {
    const destination = join(target, file.path);
    mkdirSync(dirname(destination), {recursive:true, mode:0o700});
    copyFileSync(join(source, file.path), destination, constants.COPYFILE_EXCL);
    chmodSync(destination, file.mode);
  }
}
function confirmOffline(offline) {
  if (offline !== true) throw new Error('备份或恢复前必须停止应用写入，并显式传 --offline 确认；本工具不能检测其他进程。');
}
function requireApplicationData(files) {
  if (!['identity.sqlite','workspace.json'].every(path => files.some(file => file.path === path))) throw new Error('输入不是完整的账号协作数据目录：需要 identity.sqlite 与 workspace.json。');
}

export function backupData({dataDir, output, offline = false} = {}) {
  confirmOffline(offline);
  if (!dataDir) throw new Error('备份必须显式提供 --data 数据目录。');
  const source = realpathSync(resolve(dataDir));
  if (lstatSync(resolve(dataDir)).isSymbolicLink()) throw new Error('数据输入不能是符号链接。');
  const target = newDestination(output, source);
  const files = filesIn(source);
  requireApplicationData(files);
  mkdirSync(target, {mode:0o700});
  try {
    copyFiles(source, join(target, 'data'), files);
    if (!sameContents(files, filesIn(join(target, 'data'))) || !sameContents(files, filesIn(source))) throw new Error('复制期间数据发生变化或校验失败；请确认应用已停止写入后重试。');
    const manifest = {format:'cobuild-offline-backup-v1', createdAt:new Date().toISOString(), files};
    writeFileSync(join(target, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', {flag:'wx', mode:0o600});
    verifyBackup(target);
    return {ok:true, files:files.length, bytes:files.reduce((sum, file) => sum + file.size, 0)};
  } catch (error) { rmSync(target, {recursive:true, force:true}); throw error; }
}

export function verifyBackup(backupDir) {
  if (!backupDir) throw new Error('需要指定 --backup 备份目录。');
  const source = resolve(backupDir);
  if (lstatSync(source).isSymbolicLink() || !statSync(source).isDirectory()) throw new Error('备份输入必须是普通目录。');
  const entries = readdirSync(source).sort();
  if (entries.length !== 2 || !entries.includes(MANIFEST) || !entries.includes('data')) throw new Error('备份目录结构不正确或含清单外文件。');
  const manifestPath = join(source, MANIFEST), stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('备份清单格式不正确。');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { throw new Error('备份清单无法解析。'); }
  const validPath = value => typeof value === 'string' && !/[\\\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..') && !isAbsolute(value);
  if (!manifest || typeof manifest !== 'object' || manifest.format !== 'cobuild-offline-backup-v1' || !Array.isArray(manifest.files) || manifest.files.length > 50000 || manifest.files.some(file => !file || typeof file !== 'object' || !validPath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)) throw new Error('备份清单字段不正确。');
  const files = [...manifest.files].sort((a,b) => a.path.localeCompare(b.path,'en'));
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('备份清单存在重复路径。');
  requireApplicationData(files);
  if (!sameContents(files, filesIn(join(source, 'data')))) throw new Error('备份文件与 SHA-256 清单不一致，拒绝恢复。');
  return {ok:true, files:files.length, bytes:files.reduce((sum, file) => sum + file.size, 0)};
}

export function restoreData({backupDir, output, offline = false} = {}) {
  confirmOffline(offline);
  verifyBackup(backupDir);
  const source = realpathSync(resolve(backupDir)), target = newDestination(output, source);
  const files = JSON.parse(readFileSync(join(source, MANIFEST),'utf8')).files;
  mkdirSync(target, {mode:0o700});
  try {
    copyFiles(join(source, 'data'), target, files, true);
    if (!sameContents([...files].sort((a,b) => a.path.localeCompare(b.path,'en')), filesIn(target))) throw new Error('恢复后校验失败。');
    return {ok:true, files:files.length, bytes:files.reduce((sum, file) => sum + file.size, 0)};
  } catch (error) { rmSync(target, {recursive:true, force:true}); throw error; }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, ...args] = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === '--offline') { if (options.offline) throw new Error('参数不能重复。'); options.offline = true; continue; }
      const key = ({'--data':'dataDir','--backup':'backupDir','--out':'output'})[flag];
      if (!key || !args[i + 1] || args[i + 1].startsWith('--') || options[key]) throw new Error('参数格式不正确。');
      options[key] = args[++i];
    }
    let result;
    if (command === 'backup' && !options.backupDir) result = backupData(options);
    else if (command === 'restore' && !options.dataDir) result = restoreData(options);
    else if (command === 'verify' && options.backupDir && Object.keys(options).length === 1) result = verifyBackup(options.backupDir);
    else throw new Error('用法：backup --data 数据目录 --out 新备份目录 --offline；restore --backup 备份目录 --out 新数据目录 --offline；verify --backup 备份目录。');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write((['ENOENT','EACCES','EPERM','ENOTDIR'].includes(error.code) ? '输入不可读或输出父目录不可写，请检查目录与运行用户权限。' : error.message) + '\n'); process.exitCode = 1; }
}
