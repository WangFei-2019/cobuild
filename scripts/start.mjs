import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runtimeEnvironment, runtimeOptions } from './runtime-config.mjs';
import { validateServerConfig } from '../server.mjs';

// Read file-backed credentials before launching; values are never printed.
let childEnv;
try { childEnv = runtimeEnvironment(process.env); }
catch (error) { process.stderr.write(error.message + '\n'); process.exit(1); }
const args = process.argv.slice(2);
const configIndex = args.indexOf('--ai-config-stdin');
if (configIndex >= 0) {
  args.splice(configIndex, 1);
  const tty = Boolean(process.stdin.isTTY);
  if (tty && spawnSync('stty', ['-echo'], { stdio:'inherit' }).status !== 0) {
    process.stderr.write('无法关闭终端回显，未读取运行配置。\n'); process.exit(1);
  }
  try {
    process.stdout.write('Ready for temporary AI configuration on stdin (input is hidden).\n');
    const input = createInterface({ input:process.stdin, terminal:false });
    const line = await new Promise((resolve,reject) => {
      input.once('line', value => { resolve(value); input.close(); });
      input.once('close', () => reject(new Error('closed')));
    });
    const values = JSON.parse(line);
    const allowed = new Set(['COBUILD_AI_BASE_URL','COBUILD_AI_MODEL','COBUILD_AI_API_KEY','COBUILD_AI_RESPONSE_FORMAT','COBUILD_AI_TOKEN_PARAMETER','COBUILD_AI_TIMEOUT_MS','COBUILD_AI_MAX_TOKENS','COBUILD_AI_THINKING']);
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(name => !allowed.has(name))) throw new Error('configuration');
    for (const [name,value] of Object.entries(values)) {
      if (typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) throw new Error('configuration');
      childEnv[name] = value;
    }
  } catch {
    process.stderr.write('无法读取临时AI运行配置，未输出输入内容。\n'); process.exitCode = 1;
  } finally {
    if (tty) spawnSync('stty', ['echo'], { stdio:'inherit' });
  }
  if (process.exitCode) process.exit(process.exitCode);
}
let options;
try {
  options = runtimeOptions(childEnv, args);
  validateServerConfig(options);
} catch (error) { process.stderr.write(error.message + '\n'); process.exit(1); }
// Explicit arguments ensure PORT also works on platforms whose server CLI only reads COBUILD_PORT.
const serverArgs = ['--host', options.host, '--port', String(options.port)];
const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), ...serverArgs], {
  env: childEnv,
  stdio: 'inherit'
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('服务进程未能启动。\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
