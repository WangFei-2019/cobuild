import http from 'node:http';
import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {dirname, extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist-pages');
if (!existsSync(resolve(root,'index.html'))) {
  process.stderr.write('请先运行 pnpm build:pages，再打开演示预览。\n'); process.exit(1);
}
const args = process.argv.slice(2);
if (!(args.length === 0 || args.length === 2 && args[0] === '--port')) {
  process.stderr.write('用法：node scripts/preview-pages.mjs [--port 4173]\n'); process.exit(1);
}
const port = Number(args.length ? args[1] : 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) { process.stderr.write('端口需要为 1–65535 的整数。\n'); process.exit(1); }
const base = '/cobuild/', realRoot = realpathSync(root);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.md':'text/markdown; charset=utf-8','.txt':'text/plain; charset=utf-8'};
const server = http.createServer((req,res) => {
  const send = (status, value = '', headers = {}) => {
    res.writeHead(status, {'X-Content-Type-Options':'nosniff','Cache-Control':'no-store',...headers});
    res.end(req.method === 'HEAD' ? '' : value);
  };
  if (!['GET','HEAD'].includes(req.method)) return send(405, 'Static demo only.', {Allow:'GET, HEAD'});
  try {
    const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if (pathname === '/' || pathname === '/cobuild') return send(302,'',{Location:base});
    if (!pathname.startsWith(base)) return send(404,'Not found');
    const relative = pathname.slice(base.length) || 'index.html';
    const file = resolve(root,relative);
    if (!file.startsWith(root + sep) || !existsSync(file)) return send(404,'Not found');
    const actual = realpathSync(file);
    if (!actual.startsWith(realRoot + sep) || !statSync(actual).isFile()) return send(404,'Not found');
    send(200, readFileSync(actual), {'Content-Type':types[extname(actual)] || 'application/octet-stream',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
  } catch { send(404,'Not found'); }
});
server.on('error', error => { process.stderr.write(error.code === 'EADDRINUSE' ? '端口已占用，请停止旧预览或使用 --port 指定其它端口。\n' : '无法启动本机演示预览。\n'); process.exitCode = 1; });
server.listen(port,'127.0.0.1',()=>process.stdout.write(`共建 · GitHub Pages 演示预览\nLocal: http://127.0.0.1:${port}${base}\n仅提供静态文件；数据保存在浏览器，不运行账号、邀请或模型服务。\n`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close());
