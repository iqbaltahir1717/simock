// UI smoke test: loads dist/ui.html in a sandboxed, null-origin iframe (like Figma does)
// with a mock main thread in the parent page, then drives the real UI:
// selection -> PSD upload -> template detection -> drag -> export download.
// It does NOT exercise Figma's own APIs; src/plugin/code.ts must be tested inside Figma.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const ui = await readFile(resolve('dist/ui.html'), 'utf8');
const psd = resolve('harness/out/synthetic.psd');

const host = `<!doctype html><html><body style="margin:0">
<iframe id="ui" sandbox="allow-scripts allow-popups allow-downloads" style="width:960px;height:680px;border:0"></iframe>
<script>
const frame = document.getElementById('ui');
frame.srcdoc = ${JSON.stringify(ui).replace(/<\/script/gi, '<\\/script')};
window.log = []; let templates = {};
async function png(w, h, scale) {
  const c = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale)), g = c.getContext('2d');
  g.fillStyle = '#0000ff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 40 * scale, 40 * scale);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}
const toUi = (m) => frame.contentWindow.postMessage({ pluginMessage: m }, '*');
window.addEventListener('message', async (e) => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data.pluginMessage; window.log.push(m.type + (m.scale ? '@' + m.scale.toFixed(2) : ''));
  if (m.type === 'export-design') toUi({ type: 'design-image', requestId: m.requestId, bytes: await png(600, 400, m.scale), scale: m.scale });
  if (m.type === 'load-templates') toUi({ type: 'templates', templates });
  if (m.type === 'save-template') { templates[m.template.hash] = m.template; window.savedTemplate = m.template; toUi({ type: 'templates', templates }); }
  if (m.type === 'refresh') sendSel();
});
window.sendSel = async () => toUi({ type: 'selection', frame: { id: '1:2', name: 'Home screen', width: 600, height: 400, preview: await png(600, 400, 0.2) } });
frame.onload = () => setTimeout(sendSel, 200);
</script></body></html>`;

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 980, height: 700 } });
const errors = [];
page.setDefaultTimeout(15000);
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
console.error('launched'); await page.setContent(host, { waitUntil: 'domcontentloaded' }); console.error('content set');
const f = page.frameLocator('#ui');
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); console.error('  PASS', name); }
  catch (e) { results.push(['FAIL', name + ': ' + e.message.split('\n')[0]]); console.error('  FAIL', name, '|', e.message.split('\n')[0], errors.slice(-3)); }
};

await step('shows selected frame name and size', async () => { await f.getByText('Home screen').waitFor({ timeout: 10000 }); await f.getByText('600 × 400').first().waitFor(); });
await step('uploads PSD and lists the Smart Object', async () => {
  await f.locator('input[type=file]').setInputFiles(psd);
  await f.locator('.cand').getByText('perspective').waitFor({ timeout: 20000 });
});
await step('shows fidelity self-check', async () => { await f.getByText(/Reproduces Photoshop's composite/).waitFor({ timeout: 10000 }); });
await step('renders a preview canvas', async () => { await f.locator('.preview canvas').waitFor({ timeout: 20000 }); });
await step('drag moves the design in placeholder space', async () => {
  const box = await f.locator('.preview canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.5 + 40, box.y + box.height * 0.45 + 10, { steps: 5 }); await page.mouse.up();
  const x = await f.locator('input[type=number]').first().inputValue();
  if (!(Number(x) > 20)) throw new Error('offsetX after drag = ' + x);
});
await step('shows output dimensions for 2×', async () => { await f.getByRole('button', { name: '2×' }).click(); await f.getByText('2400 × 1600 px').waitFor(); });
await step('refuses nothing at 4× for this size', async () => { await f.getByRole('button', { name: '4×' }).click(); await f.getByText('4800 × 3200 px').waitFor(); });
let download;
await step('exports a JPG download at 1×', async () => {
  await f.getByRole('button', { name: '1×' }).click();
  await f.getByRole('button', { name: 'JPG' }).click();
  await f.getByText(/Quality/).waitFor();
  const dl = page.waitForEvent('download', { timeout: 30000 });
  await f.getByRole('button', { name: 'Export' }).click();
  download = await dl;
  await mkdir('harness/out', { recursive: true });
  await download.saveAs(resolve('harness/out/ui-export.jpg'));
  if (!download.suggestedFilename().endsWith('@1x.jpg')) throw new Error(download.suggestedFilename());
});
await step('saves template with target and placement', async () => {
  await page.waitForFunction(() => !!window.savedTemplate, null, { timeout: 5000 });
  const t = await page.evaluate(() => window.savedTemplate);
  if (t.target.name !== 'Screen' || !(t.placement.offsetX > 20)) throw new Error(JSON.stringify(t));
});
await step('re-opening the same PSD restores the saved placement', async () => {
  await f.getByRole('button', { name: 'Center' }).click();
  await f.locator('input[type=file]').setInputFiles(psd);
  await f.getByText('saved template').waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  const x = await f.locator('input[type=number]').first().inputValue();
  if (!(Number(x) > 20)) throw new Error('offsetX after reopen = ' + x);
});
await step('refresh re-requests the selection', async () => {
  await f.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForFunction(() => window.log.includes('refresh'));
});
await page.screenshot({ path: 'harness/out/ui-smoke.png' });
const log = await page.evaluate(() => window.log);
await browser.close();
console.error('  messages:', log.join(' '));
if (errors.length) console.error('  page errors:', errors);
await writeFile('harness/out/ui-smoke.json', JSON.stringify({ results, log, errors }, null, 2));
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
