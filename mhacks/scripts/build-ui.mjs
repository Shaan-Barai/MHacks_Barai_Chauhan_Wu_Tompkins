import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'frontend/dist');
await mkdir(out, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['frontend/main.tsx'], bundle: true, minify: true, format: 'esm', platform: 'browser', target: ['es2022'], jsx: 'automatic', outfile: resolve(out, 'main.js'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'info' });
await copyFile(resolve(out, 'main.css'), resolve(out, 'styles.css'));
await Promise.all([copyFile(resolve(root, 'frontend/index.html'), resolve(out, 'index.html')), copyFile(resolve(root, 'frontend/demo-data.json'), resolve(out, 'demo-data.json'))]);
console.log('Built the static demo in frontend/dist. No environment files are included.');
