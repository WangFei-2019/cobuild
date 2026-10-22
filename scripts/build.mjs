import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await build({absWorkingDir:root,entryPoints:['scripts/smtp-source.mjs'],bundle:true,outfile:'smtp-transport.mjs',platform:'node',format:'esm',minify:true,sourcemap:false,target:['node24'],legalComments:'inline',logLevel:'info'});
await build({
  absWorkingDir: root,
  entryPoints:['src/main.jsx'],
  bundle:true,
  outfile:'public/app.js',
  format:'esm',
  minify:true,
  sourcemap:false,
  target:['es2022'],
  alias:{'node:crypto':resolve(root,'src/browser-crypto.js')},
  define:{'process.env.NODE_ENV':'"production"',__COBUILD_DEMO__:'false'},
  legalComments:'external',
  logLevel:'info'
});
await import('./licenses.mjs');
