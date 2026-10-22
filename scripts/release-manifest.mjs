import {createHash} from 'node:crypto';
import {lstatSync, readdirSync, readFileSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';

export const MANIFEST_NAME = 'RELEASE-MANIFEST.json';
const rootFiles = new Set([
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  '.gitignore', '.gitattributes', '.dockerignore', '.env.example', 'Dockerfile', 'Caddyfile',
  'compose.yaml', 'compose.registry.yaml',
  'README.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE', 'LICENSE.md',
  '部署与配置.md', 'GitHub发布与部署.md', '设计依据.md', '竞品与首版取舍.md',
]);
const publicFiles = new Set([
  'public/index.html', 'public/app.js', 'public/app.css',
  'public/app.js.LEGAL.txt', 'public/THIRD_PARTY_NOTICES.txt',
]);
const traversedDirectories = new Set(['src', 'public', 'scripts', 'tests', '.github', 'demo']);
export const REQUIRED_RELEASE_FILES = Object.freeze([
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'server.mjs', 'domain.mjs',
  'workspace.mjs', 'identity.mjs', 'mail.mjs', 'notifications.mjs', 'notification-store.mjs', 'people.mjs', 'dashboard.mjs', 'planning.mjs', 'insights.mjs', 'ai-exchange.mjs', 'tests/insights.test.mjs',
  'scripts/build.mjs', 'scripts/start.mjs', 'scripts/runtime-config.mjs', 'scripts/doctor.mjs', 'scripts/backup.mjs', 'scripts/licenses.mjs',
  'scripts/package-release.mjs', 'scripts/release-manifest.mjs', 'scripts/verify-release.mjs',
  'public/index.html', 'public/app.js', 'public/app.css', 'public/THIRD_PARTY_NOTICES.txt',
  'src/main.jsx', 'README.md', 'Dockerfile', 'compose.yaml', 'compose.registry.yaml',
  '.github/workflows/ci.yml', '.github/workflows/publish-image.yml', '.github/workflows/pages.yml',
  'scripts/build-pages.mjs', 'src/service-entry.jsx', 'src/service-entry.css', 'src/service-origin.js', 'src/browser-crypto.js', 'src/demo-api.js', 'demo/seed.json',
]);

export function isReleaseFile(path) {
  if (typeof path !== 'string' || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (!path.includes('/')) return rootFiles.has(path) || /^[a-z][a-z0-9-]*\.mjs$/.test(path);
  if (publicFiles.has(path)) return true;
  if (/^public\/samples\/[^/.][^/]*\.(md|json|txt)$/.test(path)) return true;
  if (/^src\/(?:[^/.][^/]*\/)*[^/.][^/]*\.(jsx?|css|json|svg)$/.test(path)) return true;
  if (/^scripts\/[a-z][a-z0-9-]*\.mjs$/.test(path)) return true;
  if (/^tests\/[a-z][a-z0-9-]*\.test\.mjs$/.test(path)) return true;
  if (path === 'demo/seed.json') return true;
  return /^\.github\/workflows\/[a-z][a-z0-9-]*\.ya?ml$/.test(path);
}

export function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function assertSafeContent(path, bytes) {
  const content = bytes.toString('utf8');
  // Recognisable credentials only: fixture strings and variable names are not credentials.
  const credential = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|\bsk-[A-Za-z0-9_-]{24,}|\bre_[A-Za-z0-9_-]{24,}/;
  if (credential.test(content)) throw new Error('疑似凭据，拒绝打包：' + path);
}

export function collectReleaseFiles(root) {
  const base = resolve(root);
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, {withFileTypes:true})) {
      const location = join(directory, entry.name);
      const path = relative(base, location).split(sep).join('/');
      if (entry.isDirectory()) {
        if (directory === base && !traversedDirectories.has(entry.name)) continue;
        if (entry.name.startsWith('.') && path !== '.github') continue;
        walk(location);
      } else if (isReleaseFile(path)) {
        if (!lstatSync(location).isFile()) throw new Error('发布文件必须是普通文件：' + path);
        const bytes = readFileSync(location);
        assertSafeContent(path, bytes);
        files.push({path, size:bytes.length, sha256:hashFile(location)});
      }
    }
  }
  walk(base);
  files.sort((a,b) => a.path.localeCompare(b.path, 'en'));
  for (const path of REQUIRED_RELEASE_FILES) {
    if (!files.some(file => file.path === path)) throw new Error('缺少发布文件：' + path);
  }
  const meta = JSON.parse(readFileSync(join(base,'package.json'),'utf8'));
  if (!/^(?:>=|\^|~)?24(?:\D|$)/.test(String(meta.engines?.node))) throw new Error('发布运行时必须明确要求 Node.js 24');
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(meta.packageManager || '')) throw new Error('缺少固定 pnpm packageManager 版本');
  return files;
}

export function listAllFiles(root) {
  const base = resolve(root);
  const paths = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, {withFileTypes:true})) {
      const location = join(directory,entry.name);
      const path = relative(base,location).split(sep).join('/');
      if (entry.isDirectory()) walk(location);
      else {
        if (!lstatSync(location).isFile()) throw new Error('发布目录含非普通文件：' + path);
        paths.push(path);
      }
    }
  }
  walk(base);
  return paths.sort();
}
