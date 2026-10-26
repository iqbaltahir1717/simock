// Builds the Figma plugin (main thread + single-file UI) and the browser test harness.
import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
// Hosted UI (optional): where dist/ui.html is published, e.g. https://you.github.io/simock/
const UI_URL = process.env.SIMOCK_UI_URL ?? '';
const PLUGIN_ID = process.env.SIMOCK_PLUGIN_ID ?? '*';
const uiOrigin = UI_URL ? new URL(UI_URL).origin : '';
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
      await writeFile('dist/ui.html', html.replace('%SIMOCK_UI_URL%', UI_URL).replace('<!--SCRIPT-->', () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`));
    });
  },
};
const ui = { ...common, entryPoints: ['src/ui/main.tsx'], outfile: 'dist/ui.js', target: 'es2020', format: 'iife', jsx: 'automatic', plugins: [inlineUi], define: { __PLUGIN_ID__: JSON.stringify(PLUGIN_ID) } };

const harness = { ...common, minify: false, entryPoints: ['harness/harness.ts'], outfile: 'harness/dist/harness.js', target: 'es2020', format: 'iife' };

// Manifest: network access for Photopea (optional renderer) and the hosted UI, if configured.
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
manifest.networkAccess.allowedDomains = ['https://www.photopea.com', ...(uiOrigin ? [uiOrigin] : [])];
manifest.networkAccess.reasoning = 'Optional Photopea renderer (only after the user opts in)' + (uiOrigin ? `, and the plugin's own UI page at ${uiOrigin} which stores the mockup library on this device.` : '.');
await writeFile('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

if (watch) {
  for (const o of [code, ui, harness]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(code), esbuild.build(ui), esbuild.build(harness)]);
}
