// Hosted-UI smoke test. Build first with:  SIMOCK_UI_URL=https://simock.test/ node build.mjs
// Simulates Figma: a page on https://www.figma.com embeds the bundled UI as a data: URL (null
// origin). The bundled UI redirects to the hosted copy on https://simock.test/ (both domains are
// served locally by Playwright routes), where the mockup library can use IndexedDB.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const ui = await readFile(resolve('dist/ui.html'));
const psd = resolve(process.argv[2] ?? 'harness/out/synthetic.psd');
const offline = process.argv.includes('--offline');

const host = `<!doctype html><html><body style="margin:0">
<iframe id="ui" sandbox="allow-scripts allow-same-origin allow-popups allow-downloads" style="width:960px;height:680px;border:0"
  src="data:text/html;base64,${ui.toString('base64')}"></iframe>
<script>
const frame = document.getElementById('ui');
window.log = []; let templates = {};
async function png(w, h, scale) {
  const c = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale)), g = c.getContext('2d');
  g.fillStyle = '#0000ff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 40 * scale, 40 * scale);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
const toUi = (m) => frame.contentWindow.postMessage({ pluginMessage: m }, '*');
window.addEventListener('message', async (e) => {
  if (e.source !== frame.contentWindow || !e.data || !e.data.pluginMessage) return;
  const m = e.data.pluginMessage; window.log.push(m.type + '|' + e.origin + '|' + e.data.pluginId);
  if (m.type === 'export-design') toUi({ type: 'design-image', requestId: m.requestId, bytes: await png(600, 400, m.scale), scale: m.scale });
  if (m.type === 'load-templates') { toUi({ type: 'templates', templates }); sendSel(); }
  if (m.type === 'save-template') { templates[m.template.hash] = m.template; toUi({ type: 'templates', templates }); }
});
window.sendSel = async () => toUi({ type: 'selection', frame: { id: '1:2', name: 'Home screen', width: 600, height: 400, preview: await png(600, 400, 0.2) } });
</script></body></html>`;

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 980, height: 700 } });
await context.route('https://www.figma.com/**', (r) => r.fulfill({ contentType: 'text/html', body: host }));
await context.route('https://simock.test/**', (r) => (offline ? r.abort() : r.fulfill({ contentType: 'text/html', body: ui })));
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const f = page.frameLocator('#ui');
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); console.error('  PASS', name); }
  catch (e) { results.push(['FAIL', name]); console.error('  FAIL', name, '|', e.message.split('\n')[0], errors.slice(-3)); }
};
const uiOrigin = () => page.evaluate(() => { try { return document.getElementById('ui').contentWindow.location.origin; } catch { return 'cross-origin'; } });

await page.goto('https://www.figma.com/plugin-host');
if (offline) {
  await step('offline: stays on bundled UI and explains the library', async () => {
    await f.getByText(/library needs the hosted plugin UI/).waitFor();
    await f.getByText('Home screen').waitFor();
  });
} else {
  await step('redirects to the hosted UI and talks to Figma with pluginId', async () => {
    await f.getByText('Home screen').waitFor();
    const log = await page.evaluate(() => window.log);
    if (!log.some((l) => l.startsWith('load-templates|https://simock.test|*'))) throw new Error(JSON.stringify(log));
  });
  await step('adds an uploaded PSD to the library', async () => {
    await f.locator('input[type=file]').setInputFiles(psd);
    await f.locator('.tile').first().waitFor();
  });
  await step('library survives reopening the plugin', async () => {
    await page.reload();
    await f.getByText('Home screen').waitFor();
    await f.locator('.tile').first().waitFor();
  });
  await step('opens a mockup from the library', async () => {
    await f.locator('.tile .thumb').first().click();
    await f.locator('.cand').first().waitFor();
    await f.locator('.preview canvas').waitFor();
  });
  await step('deletes with confirmation', async () => {
    await f.getByRole('button', { name: 'Delete' }).first().click();
    await f.getByRole('button', { name: 'Confirm delete' }).click();
    await f.locator('.tile').first().waitFor({ state: 'detached' });
  });
}
await page.screenshot({ path: `harness/out/hosted-smoke${offline ? '-offline' : ''}.png` });
await browser.close();
if (errors.length) console.error('  page errors:', errors);
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
