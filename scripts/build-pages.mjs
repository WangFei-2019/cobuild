import {build} from 'esbuild';
import {cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root,'dist-pages');
// dist-pages is a generated directory only. No state, env or server directory is copied.
rmSync(output,{recursive:true,force:true});
mkdirSync(output,{recursive:true});
const result = await build({
  absWorkingDir:root,
  entryPoints:['src/main.jsx'],
  bundle:true,
  outfile:join(output,'app.js'),
  platform:'browser',
  format:'esm',
  minify:true,
  sourcemap:false,
  target:['es2022'],
  define:{'process.env.NODE_ENV':'"production"',__COBUILD_DEMO__:'true'},
  alias:{'node:crypto':join(root,'src/browser-crypto.js')},
  legalComments:'external',
  metafile:true,
  logLevel:'info',
});
const inputs = Object.keys(result.metafile.inputs);
if (!inputs.some(path => /(^|\/)src\/demo-api\.js$/.test(path)) || !inputs.some(path => /(^|\/)demo\/seed\.json$/.test(path))) throw new Error('Pages 构建必须包含独立演示适配器和公开种子数据');
for (const path of inputs) {
  if (/(^|\/)(server|workspace|identity)\.mjs$/.test(path)) throw new Error('静态演示不能包含服务器或身份数据库模块：' + path);
}
const bundle = readFileSync(join(output,'app.js'),'utf8');
// UI help may mention an environment variable by name; reject executable server reads.
if (/process\.env(?:\.COBUILD_|\[['"]COBUILD_)|node:fs|node:sqlite/.test(bundle)) throw new Error('静态构建包含不应发布的服务器配置读取或 Node 模块');
let html = readFileSync(join(root,'public/index.html'),'utf8');
const assetVersions = Object.fromEntries(['css','js'].map(extension => [
  extension,
  createHash('sha256').update(readFileSync(join(output,'app.' + extension))).digest('hex').slice(0,12),
]));
html = html.replace(/(href|src)="\/app\.(css|js)"/g,(_match,attribute,extension) => attribute + '="./app.' + extension + '?v=' + assetVersions[extension] + '"');
html = html.replace('<title>共建 · 项目工作台</title>','<title>共建 · 交互演示</title>');
if (!html.includes('src="./app.js?v=' + assetVersions.js + '"') || !html.includes('href="./app.css?v=' + assetVersions.css + '"')) throw new Error('演示入口必须使用带内容版本的相对资源路径');
writeFileSync(join(output,'index.html'),html);
writeFileSync(join(output,'.nojekyll'),'');
const samples = join(root,'public/samples');
for (const entry of readdirSync(samples)) {
  const path = join(samples,entry);
  if (!lstatSync(path).isFile() || !/\.(md|json|txt)$/.test(entry)) throw new Error('演示示例目录只允许普通文本文件');
}
cpSync(samples,join(output,'samples'),{recursive:true});
const sections = ['CoBuild Pages demo — third-party notices','Additional package notices are preserved in app.js.LEGAL.txt.'];
for (const name of ['antd','@ant-design/icons','react','react-dom','@noble/hashes']) {
  const location = join(root,'node_modules',name);
  const meta = JSON.parse(readFileSync(join(location,'package.json'),'utf8'));
  sections.push('\n' + name + ' ' + meta.version + '\n' + '-'.repeat(60) + '\n' + readFileSync(join(location,'LICENSE'),'utf8'));
}
writeFileSync(join(output,'THIRD_PARTY_NOTICES.txt'),sections.join('\n'));
console.log('Pages demo built to dist-pages. Static browser data only; no server or model key is included.');
