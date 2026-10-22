import {readFileSync, statSync} from 'node:fs';

// Shared by the launcher and read-only diagnostics; credential values never enter reports.
export function runtimeEnvironment(source = process.env) {
  const env = {...source};
  for (const name of ['COBUILD_SETUP_TOKEN', 'COBUILD_AI_API_KEY', 'COBUILD_MAIL_API_KEY']) {
    const file = env[name + '_FILE'];
    let value = env[name] || '';
    if (file) {
      try {
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > 16384) throw new Error();
        value = readFileSync(file, 'utf8');
      } catch { throw new Error(name + '_FILE 指定的配置文件无法读取或格式不正确。'); }
    }
    if (typeof value !== 'string') throw new Error(name + ' 配置格式不正确。');
    value = value.trim();
    if (/[\r\n\0]/.test(value) || value.length > (name === 'COBUILD_SETUP_TOKEN' ? 1024 : 8192)) throw new Error(name + ' 配置格式不正确。');
    if (file && name === 'COBUILD_SETUP_TOKEN' && !value) throw new Error('COBUILD_SETUP_TOKEN_FILE 不能是空文件或只含空白。');
    env[name] = value;
  }
  return env;
}

export function runtimeOptions(env, args = [], {production = false} = {}) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!['--host', '--port'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--') || values[flag] !== undefined) throw new Error('启动参数仅支持 --host 和 --port，且不能重复。');
    values[flag] = args[i + 1];
  }
  const port = Number(values['--port'] || env.COBUILD_PORT || env.PORT || '4173');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口需要为 1–65535 的整数。');
  const host = values['--host'] || (production ? '0.0.0.0' : '127.0.0.1');
  const publicUrl = env.COBUILD_PUBLIC_URL || '';
  const domain = (env.COBUILD_DOMAIN || '').trim();
  if (domain) {
    try {
      if (/[\s\/@?#]/.test(domain)) throw new Error();
      const actual = new URL('https://' + domain);
      const published = new URL(publicUrl);
      if (actual.host !== published.host || published.protocol !== 'https:') throw new Error();
    } catch { throw new Error('COBUILD_DOMAIN 需为与 COBUILD_PUBLIC_URL 一致的 HTTPS 主机名，不含协议或路径。'); }
  }
  return {host, port, publicUrl};
}
