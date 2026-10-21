import {accessSync, constants, existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Read-only diagnostics: no setup, database writes or provider requests.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
const checks = [];
const add = (name, level, message) => checks.push({name, level, message});
if ([...flags].some(flag => !['--production', '--json'].includes(flag))) add('arguments', 'error', '只支持 --production 与 --json。');
const runtimeOK = Number(process.versions.node.split('.')[0]) >= 24;
add('runtime', runtimeOK ? 'ok' : 'error', runtimeOK ? `Node.js ${process.versions.node}` : '需要 Node.js 24 或更新版本。');

for (const name of ['public/index.html', 'public/app.js', 'public/app.css', 'public/THIRD_PARTY_NOTICES.txt']) {
  try {
    const stat = statSync(resolve(root, name));
    if (!stat.isFile() || !stat.size) throw new Error();
    add(name, 'ok', '文件存在且非空。');
  } catch { add(name, 'error', '缺少构建资源，请先安装依赖并运行 pnpm build。'); }
}
try {
  const file = resolve(process.env.COBUILD_DATA_DIR || resolve(root, '.local'));
  let ancestor = file;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  if (!statSync(ancestor).isDirectory()) throw new Error();
  accessSync(ancestor, constants.W_OK | constants.X_OK);
  add('storage', 'ok', existsSync(file) ? '数据目录具备写入权限；未修改任何数据。' : '数据目录尚未创建，其父目录可写；启动时创建。');
} catch { add('storage', 'error', '数据目录或其父目录不可写，请检查挂载卷与运行用户权限。'); }

function hasSecret(name) {
  if (process.env[name]?.trim()) return true;
  const path = process.env[`${name}_FILE`];
  if (!path) return false;
  try { accessSync(path, constants.R_OK); return statSync(path).isFile() && statSync(path).size > 0; }
  catch { return false; }
}
if (runtimeOK) {
  try {
    const {validateServerConfig} = await import('../server.mjs');
    const production = flags.has('--production');
    const publicUrl = process.env.COBUILD_PUBLIC_URL || '';
    if (production && !publicUrl) throw new Error('公开部署需要配置 COBUILD_PUBLIC_URL。');
    validateServerConfig({host: production ? '0.0.0.0' : '127.0.0.1', port:4173, publicUrl});
    add('server', 'ok', production ? '公开地址与 HTTPS 监听规则通过。' : '本机监听规则通过。');
    if (production) add('setup-secret', hasSecret('COBUILD_SETUP_TOKEN') ? 'ok' : 'error', hasSecret('COBUILD_SETUP_TOKEN') ? '已提供初始化口令配置；不显示其内容。' : '公开部署需提供 COBUILD_SETUP_TOKEN 或可读的 COBUILD_SETUP_TOKEN_FILE。');
  } catch (error) { add('server', 'error', error.message); }
  try {
    const {aiStatus} = await import('../planning.mjs');
    const previous = process.env.COBUILD_AI_API_KEY;
    // Test file-backed configuration without reading its credential contents.
    if (!previous?.trim() && hasSecret('COBUILD_AI_API_KEY')) process.env.COBUILD_AI_API_KEY = 'doctor-file-presence-only';
    try {
      const status = aiStatus();
      const requested = ['COBUILD_AI_BASE_URL', 'COBUILD_AI_MODEL', 'COBUILD_AI_API_KEY'].some(name => process.env[name]?.trim());
      add('ai', status.configured ? 'ok' : requested ? 'error' : 'info', status.configured ? '模型配置字段通过；本检查不联网验证密钥、余额或模型能力。' : requested ? '模型配置不完整或无效，请检查服务端配置；未显示配置内容。' : '未配置 AI，仍可手动管理项目与里程碑。');
    } finally {
      if (previous === undefined) delete process.env.COBUILD_AI_API_KEY;
      else process.env.COBUILD_AI_API_KEY = previous;
    }
  } catch { add('ai', 'error', '无法检查模型模块，请核对发布文件完整性。'); }
}
const report = {ok: !checks.some(check => check.level === 'error'), checks};
if (flags.has('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  process.stdout.write('共建 · 只读运行检查\n');
  for (const check of checks) process.stdout.write(`${({ok:'✓', error:'✗', info:'·'})[check.level]} ${check.name}: ${check.message}\n`);
  process.stdout.write(report.ok ? '检查通过。公开部署后仍需核对 HTTPS、持久化和实际协作。\n' : '存在需要修复的配置，请处理以上错误后再启动。\n');
}
process.exitCode = report.ok ? 0 : 1;
