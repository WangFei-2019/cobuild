import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  absWorkingDir: root,
  entryPoints:['src/main.jsx'],
  bundle:true,
  outfile:'public/app.js',
  format:'esm',
  minify:true,
  sourcemap:false,
  target:['es2022'],
  define:{'process.env.NODE_ENV':'"production"',__COBUILD_DEMO__:'false'},
  legalComments:'external',
  logLevel:'info'
});
await import('./licenses.mjs');
