import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['antd','@ant-design/icons','react','react-dom'];
const sections = ['CoBuild frontend — third-party notices', 'Additional package notices are preserved in app.js.LEGAL.txt.'];
for (const name of packages) {
  const location = resolve(root, 'node_modules', name);
  const meta = JSON.parse(readFileSync(resolve(location,'package.json'),'utf8'));
  sections.push(`\n${name} ${meta.version}\n${'-'.repeat(60)}\n${readFileSync(resolve(location,'LICENSE'),'utf8')}`);
}
writeFileSync(resolve(root,'public','THIRD_PARTY_NOTICES.txt'), sections.join('\n'));
