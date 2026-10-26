// Runs the browser harness in headless Chromium.
//   node harness/run.mjs                 synthetic suite only
//   node harness/run.mjs path/to/a.psd   synthetic suite + real PSD report
// Outputs go to harness/out/.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

// Resolved with require so a globally installed Playwright (NODE_PATH) also works.
const { chromium } = createRequire(import.meta.url)('playwright');

const realPaths = process.argv.slice(2).map((p) => resolve(p));
for (const p of realPaths) if (!existsSync(p)) { console.error(`Not found: ${p}`); process.exit(2); }

const routes = {
  '/': { file: resolve('harness/harness.html'), type: 'text/html' },
  '/harness.js': { file: resolve('harness/dist/harness.js'), type: 'text/javascript' },
};
realPaths.forEach((p, i) => { routes[`/sample-${i}.psd`] = { file: p, type: 'application/octet-stream' }; });

const server = createServer((req, res) => {
  const r = routes[req.url];
  if (!r) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': r.type, 'content-length': statSync(r.file).size });
  createReadStream(r.file).pipe(res);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', (e) => console.error('[page error]', e.message));
await page.goto(base + '/');
await page.waitForFunction(() => !!window.simock);

const outDir = resolve('harness/out');
await mkdir(outDir, { recursive: true });
const save = async (files, prefix = '') => {
  for (const [name, data] of Object.entries(files ?? {})) await writeFile(`${outDir}/${prefix}${name}`, Buffer.from(data, 'base64'));
};

let failed = 0;
const synth = await page.evaluate(() => window.simock.runSyntheticSuite());
await save(synth.files);
await writeFile(`${outDir}/synthetic.psd`, Buffer.from(synth.psdBytes, 'base64'));
console.log('\nSynthetic suite (generated PSD, Chromium ' + browser.version() + ')');
for (const c of synth.checks) {
  if (!c.pass) failed++;
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`);
}

const report = { browser: browser.version(), synthetic: synth.checks, real: [] };
for (let i = 0; i < realPaths.length; i++) {
  const t = Date.now();
  const r = await page.evaluate(([u]) => window.simock.runRealPsd(u), [`/sample-${i}.psd`]);
  const prefix = basename(realPaths[i]).replace(/\W+/g, '_') + '-';
  await save(r.files, prefix);
  delete r.files;
  r.file = basename(realPaths[i]);
  r.totalMs = Date.now() - t;
  report.real.push(r);
  console.log(`\nReal PSD: ${r.file}`);
  console.log(JSON.stringify({ sniff: r.sniff, parseMs: r.parseMs, selfCheck: r.selfCheck, candidates: r.inspection?.candidates?.map((c) => ({ name: c.name, size: `${c.width}x${c.height}`, perspective: c.perspective, warp: c.warpStyle, issues: c.issues.map((x) => x.code) })), docIssues: r.inspection?.issues, renders: r.renders }, null, 2));
}
await writeFile(`${outDir}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
server.close();
console.log(`\n${synth.checks.length - failed}/${synth.checks.length} synthetic checks passed. Outputs in harness/out/`);
process.exit(failed ? 1 : 0);
