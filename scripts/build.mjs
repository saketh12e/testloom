import { build as bundle } from 'esbuild';
import { build as vite } from 'vite';
import { mkdir } from 'node:fs/promises';
await mkdir('dist/main', { recursive: true });
await bundle({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'playwright'], sourcemap: true });
await bundle({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await vite({ root: 'src/renderer', base: './', build: { outDir: '../../dist/renderer', emptyOutDir: true } });
