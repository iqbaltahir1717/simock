// Builds the Figma plugin (main thread + single-file UI) and the browser test harness.
import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
await mkdir('dist', { recursive: true });
await mkdir('harness/dist', { recursive: true });

const common = { bundle: true, minify: !watch, sourcemap: false, logLevel: 'info', legalComments: 'none' };

// Figma main thread: no DOM, ES2017-ish sandbox.
const code = { ...common, entryPoints: ['src/plugin/code.ts'], outfile: 'dist/code.js', target: 'es2017', format: 'iife' };

// UI: Figma loads `ui` as one HTML string, so JS is inlined.
const inlineUi = {
  name: 'inline-ui',
  setup(build) {
    build.onEnd(async (r) => {
      if (r.errors.length) return;
      const js = await readFile('dist/ui.js', 'utf8');
      const html = await readFile('src/ui/ui.html', 'utf8');
      await writeFile('dist/ui.html', html.replace('<!--SCRIPT-->', () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`));
    });
  },
};
const ui = { ...common, entryPoints: ['src/ui/main.tsx'], outfile: 'dist/ui.js', target: 'es2020', format: 'iife', jsx: 'automatic', plugins: [inlineUi] };

const harness = { ...common, minify: false, entryPoints: ['harness/harness.ts'], outfile: 'harness/dist/harness.js', target: 'es2020', format: 'iife' };

if (watch) {
  for (const o of [code, ui, harness]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(code), esbuild.build(ui), esbuild.build(harness)]);
}
