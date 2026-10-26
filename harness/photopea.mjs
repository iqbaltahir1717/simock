// Photopea renderer check. Run on a machine that can reach https://www.photopea.com:
//   node harness/photopea.mjs [path/to/mockup.psd]   (defaults to harness/out/synthetic.psd)
// Saves harness/out/photopea-*.png. Note: free Photopea shows ads inside its frame.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const psd = resolve(process.argv[2] ?? 'harness/out/synthetic.psd');
const routes = { '/': ['harness/harness.html', 'text/html'], '/harness.js': ['harness/dist/harness.js', 'text/javascript'], '/mockup.psd': [psd, 'application/octet-stream'] };
const server = createServer((req, res) => {
  const r = routes[req.url];
  if (!r) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': r[1], 'content-length': statSync(r[0]).size });
  createReadStream(r[0]).pipe(res);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const browser = await chromium.launch({ headless: process.env.HEADED ? false : true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page error]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => !!window.simock);
const out = await page.evaluate(() => window.simock.runPhotopea('/mockup.psd').catch((e) => ({ error: e.message })));
await mkdir('harness/out', { recursive: true });
for (const [n, d] of Object.entries(out.files ?? {})) await writeFile(`harness/out/${n}`, Buffer.from(d, 'base64'));
delete out.files;
console.log(JSON.stringify(out, null, 2));
await browser.close(); server.close();
