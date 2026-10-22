import {accessSync, constants, existsSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeEnvironment, runtimeOptions} from './runtime-config.mjs';

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

let env;
try { env = runtimeEnvironment(process.env); add('secrets', 'ok', '凭证格式与文件内容检查通过；不显示其内容。'); }
catch (error) { add('secrets', 'error', error.message); }
if (runtimeOK && env) {
  try {
    const {validateServerConfig} = await import('../server.mjs');
    const production = flags.has('--production');
    if (production && !env.COBUILD_PUBLIC_URL) throw new Error('公开部署需要配置 COBUILD_PUBLIC_URL。');
    const config = runtimeOptions(env, [], {production});
    validateServerConfig(config);
    add('server', 'ok', production ? '公开地址、域名与 HTTPS 监听规则通过。' : '本机监听规则通过。');
    add('port', 'ok', '监听端口 ' + config.port + '（COBUILD_PORT 优先，其次 PORT，默认 4173）。');
    if (production) add('setup-secret', env.COBUILD_SETUP_TOKEN ? 'ok' : 'error', env.COBUILD_SETUP_TOKEN ? '已提供非空初始化口令；不显示其内容。' : '公开部署需提供 COBUILD_SETUP_TOKEN 或非空的 COBUILD_SETUP_TOKEN_FILE。');
  } catch (error) { add('server', 'error', error.message); }
  try {
    const {aiStatus} = await import('../planning.mjs');
    const previous = process.env.COBUILD_AI_API_KEY;
    process.env.COBUILD_AI_API_KEY = env.COBUILD_AI_API_KEY;
    try {
      const status = aiStatus();
      const requested = ['COBUILD_AI_BASE_URL', 'COBUILD_AI_MODEL', 'COBUILD_AI_API_KEY'].some(name => env[name]?.trim());
      add('ai', status.configured ? 'ok' : requested ? 'error' : 'info', status.configured ? '模型配置字段通过；本检查不联网验证密钥、余额或模型能力。' : requested ? '模型配置不完整或无效，请检查服务端配置；未显示配置内容。' : '未配置 AI，仍可手动管理项目与里程碑。');
    } finally {
      if (previous === undefined) delete process.env.COBUILD_AI_API_KEY;
      else process.env.COBUILD_AI_API_KEY = previous;
    }
  } catch { add('ai', 'error', '无法检查模型模块，请核对发布文件完整性。'); }
  try {
    const {mailStatus} = await import('../mail.mjs');
    const status = mailStatus({env, publicUrl:env.COBUILD_PUBLIC_URL || ''});
    const requested = ['COBUILD_MAIL_FROM','COBUILD_MAIL_API_KEY','COBUILD_MAIL_SMTP_USER','COBUILD_MAIL_SMTP_PASSWORD'].some(name => env[name]?.trim());
    add('mail', status.configured ? 'ok' : requested ? 'error' : 'info', status.configured ? '邮件配置字段通过；未请求邮件服务，仍需验证发件账号与实际投递。' : requested ? '邮件配置不完整或无效，请检查服务端配置；未显示配置内容。' : '未配置邮件，邮箱验证与密码找回暂不可用；日常协作仍可用。');
  } catch { add('mail', 'error', '无法检查邮件模块，请核对发布文件完整性。'); }
}
const report = {ok: !checks.some(check => check.level === 'error'), checks};
if (flags.has('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  process.stdout.write('共建 · 只读运行检查\n');
  for (const check of checks) process.stdout.write(`${({ok:'✓', error:'✗', info:'·'})[check.level]} ${check.name}: ${check.message}\n`);
  process.stdout.write(report.ok ? '检查通过。公开部署后仍需核对 HTTPS、持久化和实际协作。\n' : '存在需要修复的配置，请处理以上错误后再启动。\n');
}
process.exitCode = report.ok ? 0 : 1;
