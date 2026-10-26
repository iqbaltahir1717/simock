// Browser-side test harness. Runs in real Chromium (same engine family as Figma's plugin
// UI) via Playwright: harness/run.mjs loads this bundle and calls window.simock.*.

import { readPsd, writePsdUint8Array, type Psd } from 'ag-psd';
import { setGaussianCalibration } from '../src/core/psd/features';
import { NativeRenderer, Compositor, compareCanvases, createSurface, encodeCanvas } from '../src/core/render/native/compositor';
import { warpInto, mapContentPoint } from '../src/core/render/native/warp';
import { quadBounds, type Quad } from '../src/core/geometry';
import { DEFAULT_PLACEMENT, type Placement } from '../src/core/placement';
import { SCALE_PRESETS, outputSize } from '../src/core/export';
import { sniffMockup } from '../src/core/validate';
import type { DesignSource } from '../src/core/render/types';

const DOC = { w: 1200, h: 800 };
const SO = { w: 600, h: 400 };
const QUAD: Quad = [{ x: 300, y: 150 }, { x: 900, y: 120 }, { x: 940, y: 600 }, { x: 260, y: 640 }];

function solid(w: number, h: number, color: string) {
  const c = createSurface(w, h); c.fillStyle = color; c.fillRect(0, 0, w, h); return c.canvas;
}

async function canvasToBytes(c: HTMLCanvasElement) {
  return new Uint8Array(await (await encodeCanvas(c, 'png', 1, '#0000')).arrayBuffer());
}

/** Builds a PSD that exercises the features mockups rely on. Pixel stand-ins are drawn by us. */
export async function makeSyntheticPsd(): Promise<Uint8Array> {
  const content = createSurface(SO.w, SO.h);
  content.fillStyle = '#ffffff'; content.fillRect(0, 0, SO.w, SO.h);
  content.fillStyle = 'rgb(0,160,0)'; content.fillRect(10, 10, SO.w - 20, SO.h - 20);
  const b = quadBounds(QUAD);
  const full = createSurface(DOC.w, DOC.h);
  warpInto(full, content.canvas, QUAD);
  const left = Math.floor(b.left), top = Math.floor(b.top), right = Math.ceil(b.right), bottom = Math.ceil(b.bottom);
  const soPixels = createSurface(right - left, bottom - top);
  soPixels.drawImage(full.canvas, -left, -top);

  const mask = createSurface(200, 200);
  mask.fillStyle = '#000'; mask.fillRect(0, 0, 200, 200);
  mask.fillStyle = '#fff'; mask.fillRect(0, 0, 100, 200);

  const psd: Psd = {
    width: DOC.w, height: DOC.h,
    children: [
      { name: 'Background', left: 20, top: 20, canvas: solid(DOC.w - 40, DOC.h - 40, 'rgb(200,200,200)') },
      { name: 'Shadow', blendMode: 'multiply', opacity: 0.5, left: 450, top: 700, canvas: solid(300, 60, '#000') },
      {
        name: 'Screen', id: 7, left, top, canvas: soPixels.canvas,
        placedLayer: { id: '20953ddb-9391-11ec-b4f1-c15674f50bc4', placed: '20953ddb-9391-11ec-b4f1-c15674f50bc4', type: 'raster', transform: QUAD.flatMap((p) => [p.x, p.y]), width: SO.w, height: SO.h },
      },
      { name: 'Glare', blendMode: 'screen', opacity: 0.3, clipping: true, left: 0, top: 0, canvas: solid(DOC.w, DOC.h, '#fff') },
      { name: 'Masked red', left: 50, top: 50, canvas: solid(200, 200, 'rgb(255,0,0)'), mask: { left: 50, top: 50, right: 250, bottom: 250, defaultColor: 0, canvas: mask.canvas } },
    ],
    linkedFiles: [{ id: '20953ddb-9391-11ec-b4f1-c15674f50bc4', name: 'screen.png', type: 'png ', data: await canvasToBytes(content.canvas) }],
  };
  // Stored composite: rendered by our compositor (so the round-trip self-check is not a fidelity test).
  const comp = new Compositor(psd);
  psd.canvas = comp.render(1);
  return writePsdUint8Array(psd, { generateThumbnail: false });
}

/** Test design: solid blue with a red marker in the top-left corner. */
function blueDesign(w = SO.w, h = SO.h): DesignSource {
  return {
    width: w, height: h,
    async getImage(scale) {
      const c = createSurface(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
      c.fillStyle = 'rgb(0,0,255)'; c.fillRect(0, 0, c.canvas.width, c.canvas.height);
      c.fillStyle = 'rgb(255,0,0)'; c.fillRect(0, 0, 40 * scale, 40 * scale);
      return c.canvas;
    },
  };
}

/** Recognisable pattern for real mockups: grid, corner markers and a label. */
function patternDesign(w: number, h: number): DesignSource {
  return {
    width: w, height: h,
    async getImage(scale) {
      const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
      const c = createSurface(W, H);
      const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#4f46e5'); g.addColorStop(1, '#ec4899');
      c.fillStyle = g; c.fillRect(0, 0, W, H);
      c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = Math.max(1, 2 * scale);
      const step = Math.max(W, H) / 12;
      for (let x = 0; x <= W; x += step) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
      for (let y = 0; y <= H; y += step) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
      const m = Math.min(W, H) * 0.08;
      [['#ef4444', 0, 0], ['#22c55e', W - m, 0], ['#eab308', W - m, H - m], ['#06b6d4', 0, H - m]].forEach(([col, x, y]) => { c.fillStyle = col as string; c.fillRect(x as number, y as number, m, m); });
      c.fillStyle = '#fff'; c.font = `bold ${Math.round(Math.min(W, H) * 0.14)}px sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('SIMOCK', W / 2, H / 2);
      return c.canvas;
    },
  };
}

function px(c: HTMLCanvasElement, x: number, y: number) {
  const d = c.getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}
async function decode(blob: Blob) {
  const bmp = await createImageBitmap(blob);
  const c = createSurface(bmp.width, bmp.height); c.drawImage(bmp, 0, 0); return c.canvas;
}
async function b64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

interface Check { name: string; pass: boolean; detail: string }

export async function runSyntheticSuite() {
  const checks: Check[] = [];
  const near = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const check = (name: string, got: number[], want: number[], tol = 3) => checks.push({ name, pass: near(got, want, tol), detail: `got ${got.join(',')} want ${want.join(',')} ±${tol}` });
  const files: Record<string, string> = {};

  const bytes = await makeSyntheticPsd();
  const sniff = sniffMockup(bytes);
  checks.push({ name: 'validator accepts PSD', pass: sniff.ok && sniff.kind === 'psd', detail: JSON.stringify(sniff) });

  const r = new NativeRenderer();
  const insp = await r.open(bytes.slice().buffer);
  checks.push({ name: 'layer order bottom→top', pass: r.psd!.children!.map((l) => l.name).join(',') === 'Background,Shadow,Screen,Glare,Masked red', detail: r.psd!.children!.map((l) => l.name).join(',') });
  const cand = insp.candidates[0];
  checks.push({ name: 'detects one perspective Smart Object', pass: insp.candidates.length === 1 && cand.name === 'Screen' && cand.perspective && cand.width === SO.w && cand.height === SO.h && cand.clippedLayersAbove === 1, detail: JSON.stringify({ n: insp.candidates.length, name: cand?.name, perspective: cand?.perspective, w: cand?.width, h: cand?.height, clipped: cand?.clippedLayersAbove, layerId: cand?.ref.layerId }) });

  const self = r.selfCheck();
  checks.push({ name: 'round-trip self-check (our own composite)', pass: !!self && self.meanAbsError < 0.5, detail: `MAE ${self?.meanAbsError.toFixed(3)}, >8: ${self?.pctPixelsOver8.toFixed(3)}%` });

  const placement: Placement = { ...DEFAULT_PLACEMENT, mode: 'fill' };
  const res = await r.render({ target: cand.ref, design: blueDesign(), placement, scale: 1, encode: { format: 'png', scale: 1, jpegQuality: 0.9, jpegBackground: '#ff00ff' } });
  const out = await decode(res.blob!);
  files['synthetic-1x.png'] = await b64(res.blob!);
  const at = (x: number, y: number) => mapContentPoint(QUAD, SO.w, SO.h, x, y);
  const c = at(300, 200), m = at(20, 20);
  check('design centre under screen glare', px(out, c.x, c.y), [77, 77, 255, 255]);
  check('design top-left marker lands at quad corner', px(out, m.x, m.y), [255, 77, 77, 255]);
  check('glare clipped to placeholder (outside quad unchanged)', px(out, 150, 400), [200, 200, 200, 255]);
  check('multiply shadow', px(out, 600, 730), [100, 100, 100, 255]);
  check('layer mask reveals', px(out, 100, 100), [255, 0, 0, 255]);
  check('layer mask hides', px(out, 200, 100), [200, 200, 200, 255]);
  check('PNG keeps transparency', px(out, 5, 5), [0, 0, 0, 0], 0);

  const jpg = await r.render({ target: cand.ref, design: blueDesign(), placement, scale: 1, encode: { format: 'jpeg', scale: 1, jpegQuality: 0.9, jpegBackground: '#ff00ff' } });
  const jo = await decode(jpg.blob!);
  files['synthetic-1x.jpg'] = await b64(jpg.blob!);
  check('JPG uses background colour for transparency', px(jo, 5, 5), [255, 0, 255, 255], 12);
  const lowQ = await r.render({ target: cand.ref, design: patternDesign(SO.w, SO.h), placement, scale: 1, encode: { format: 'jpeg', scale: 1, jpegQuality: 0.3, jpegBackground: '#fff' } });
  const highQ = await r.render({ target: cand.ref, design: patternDesign(SO.w, SO.h), placement, scale: 1, encode: { format: 'jpeg', scale: 1, jpegQuality: 0.95, jpegBackground: '#fff' } });
  checks.push({ name: 'JPG quality changes file size', pass: lowQ.blob!.size < highQ.blob!.size, detail: `q0.3 ${lowQ.blob!.size} B, q0.95 ${highQ.blob!.size} B` });

  for (const s of SCALE_PRESETS) {
    const t = await r.render({ target: cand.ref, design: blueDesign(), placement, scale: s, encode: { format: 'png', scale: s, jpegQuality: 0.9, jpegBackground: '#fff' } });
    const want = outputSize(DOC.w, DOC.h, s);
    const d = await decode(t.blob!);
    checks.push({ name: `export ${s}× dimensions`, pass: d.width === want.width && d.height === want.height, detail: `${d.width}×${d.height} in ${t.ms.toFixed(0)} ms` });
    if (s === 4) {
      check('4× design centre matches 1×', px(d, c.x * 4, c.y * 4), [77, 77, 255, 255]);
      files['synthetic-4x.png'] = await b64(t.blob!);
    }
  }

  // Placement: offset in placeholder space moves the marker along the perspective plane.
  const shifted = await r.render({ target: cand.ref, design: blueDesign(), placement: { ...placement, scale: 0.5 }, scale: 1 });
  const sc = at(150 + 10, 100 + 10); // with scale 0.5 centred, the design TL is at (150,100)
  check('scale 0.5 centred: marker at placeholder (160,110)', px(shifted.canvas!, sc.x, sc.y), [255, 77, 77, 255]);
  const off = await r.render({ target: cand.ref, design: blueDesign(), placement: { ...placement, scale: 0.5, offsetX: 100, offsetY: -50 }, scale: 1 });
  const oc = at(250 + 10, 50 + 10);
  check('offset (+100,-50) in placeholder space', px(off.canvas!, oc.x, oc.y), [255, 77, 77, 255]);
  const rot = await r.render({ target: cand.ref, design: blueDesign(), placement: { ...placement, scale: 0.5, rotation: 180 }, scale: 1 });
  const rc = at(450 - 10, 300 - 10);
  check('rotation 180° moves marker to opposite corner', px(rot.canvas!, rc.x, rc.y), [255, 77, 77, 255]);
  files['synthetic-placement.png'] = await b64(await encodeCanvas(off.canvas!, 'png', 1, '#fff'));

  let guard = '';
  try { await r.render({ target: cand.ref, design: blueDesign(), placement, scale: 40 }); } catch (e) { guard = (e as Error).message; }
  checks.push({ name: 'oversize export is refused clearly', pass: /exceeds|budget/.test(guard), detail: guard });

  const eps = sniffMockup(new TextEncoder().encode('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n'));
  checks.push({ name: 'EPS is detected and explained', pass: !eps.ok && eps.kind === 'eps', detail: eps.reason ?? '' });

  return { checks, files, psdBytes: await b64(new Blob([bytes as BlobPart])) };
}

/** Real PSD: inspect, self-check fidelity against Photoshop's stored composite, render each candidate. */
export async function runRealPsd(url: string, maxCandidates = 3) {
  const t0 = performance.now();
  const buf = await (await fetch(url)).arrayBuffer();
  const sniff = sniffMockup(new Uint8Array(buf, 0, Math.min(buf.byteLength, 64)), buf.byteLength);
  if (!sniff.ok) return { sniff };
  const r = new NativeRenderer();
  const insp = await r.open(buf);
  const parseMs = performance.now() - t0;
  const files: Record<string, string> = {};
  const self = r.selfCheck();
  if (self) files['selfcheck-diff.png'] = await b64(await encodeCanvas(self.diff, 'png', 1, '#fff'));
  if (r.psd!.canvas) files['photoshop-composite.png'] = await b64(await encodeCanvas(r.psd!.canvas, 'png', 1, '#fff'));
  // End-to-end replacement fidelity: replace the Smart Object with its own original contents
  // through our pipeline and compare with Photoshop's composite. Also calibrates blur radius.
  let replacement: unknown = null;
  const first = insp.candidates[0];
  const lf = first && r.psd!.linkedFiles?.find((f) => f.id === first.contentId);
  if (lf?.data && r.psd!.canvas) {
    // The embedded file's stored composite can be stale (it is blank in the MacBook sample),
    // so render its layers with our own compositor.
    const inner = readPsd(lf.data.slice().buffer, { skipThumbnail: true, skipLinkedFilesData: true });
    const innerCanvas = inner.children?.length ? new Compositor(inner).render(1) : inner.canvas;
    if (innerCanvas) {
      inner.canvas = innerCanvas;
      const own: DesignSource = { width: inner.width, height: inner.height, async getImage() { return innerCanvas; } };
      const placement: Placement = { ...DEFAULT_PLACEMENT, mode: 'stretch', lockAspect: false };
      const perSigma: Record<string, number> = {};
      for (const k of [0.5, 0.75, 1, 1.25]) {
        setGaussianCalibration(k);
        const res = await r.render({ target: first.ref, design: own, placement, scale: 1 });
        const f = compareCanvases(r.psd!.canvas, res.canvas!);
        perSigma[k] = +f.meanAbsError.toFixed(4);
        if (k === 1) {
          replacement = { contentSize: `${inner.width}x${inner.height}`, meanAbsError: f.meanAbsError, pctPixelsOver8: f.pctPixelsOver8, pctPixelsOver32: f.pctPixelsOver32 };
          files['replacement-diff.png'] = await b64(await encodeCanvas(f.diff, 'png', 1, '#fff'));
          files['replacement-render.png'] = await b64(await encodeCanvas(res.canvas!, 'png', 1, '#fff'));
          files['replacement-content.png'] = await b64(await encodeCanvas(inner.canvas, 'png', 1, '#fff'));
        }
      }
      setGaussianCalibration(1);
      (replacement as Record<string, unknown>).maeByBlurSigmaPerRadius = perSigma;
    }
  }
  const renders: unknown[] = [];
  for (const cand of insp.candidates.slice(0, maxCandidates)) {
    const design = patternDesign(cand.width, cand.height);
    const big = insp.candidates.indexOf(cand) === 0 ? ([[2, 'jpeg'], [4, 'jpeg']] as const) : [];
    for (const [scale, format] of [[1, 'png'], [1, 'jpeg'], [0.5, 'png'], ...big] as const) {
      try {
        const res = await r.render({ target: cand.ref, design, placement: { ...DEFAULT_PLACEMENT, mode: 'fill' }, scale, encode: { format, scale, jpegQuality: 0.9, jpegBackground: '#ffffff' } });
        const name = `real-${insp.candidates.indexOf(cand)}-${scale}x.${format === 'png' ? 'png' : 'jpg'}`;
        files[name] = await b64(res.blob!);
        renders.push({ candidate: cand.name, scale, format, width: res.width, height: res.height, ms: Math.round(res.ms), bytes: res.blob!.size, warnings: res.warnings });
      } catch (e) {
        renders.push({ candidate: cand.name, scale, format, error: (e as Error).message });
      }
    }
  }
  const { diff, ...selfNumbers } = self ?? ({} as Record<string, unknown>);
  void diff;
  return { sniff, parseMs: Math.round(parseMs), inspection: insp, selfCheck: self ? selfNumbers : null, replacement, renders, files };
}

declare global { interface Window { simock: unknown } }
window.simock = { runSyntheticSuite, runRealPsd, makeSyntheticPsd };

/**
 * Photopea path: same request through the PhotopeaRenderer. Needs network access to
 * www.photopea.com (blocked in the cloud container used for Phase 1).
 */
export async function runPhotopea(url: string) {
  const { PhotopeaRenderer } = await import('../src/core/render/photopea/photopea');
  const host = document.createElement('div');
  host.style.cssText = 'width:1200px;height:800px';
  document.body.appendChild(host);
  const buf = await (await fetch(url)).arrayBuffer();
  const r = new PhotopeaRenderer(host);
  const insp = await r.open(buf);
  const cand = insp.candidates[0];
  if (!cand) return { error: 'no smart objects' };
  const files: Record<string, string> = {};
  const renders: unknown[] = [];
  for (const scale of [1, 2]) {
    try {
      const res = await r.render({ target: cand.ref, design: patternDesign(cand.width, cand.height), placement: { ...DEFAULT_PLACEMENT, mode: 'fill' }, scale, encode: { format: 'png', scale, jpegQuality: 0.9, jpegBackground: '#fff' } });
      files[`photopea-${scale}x.png`] = await b64(res.blob!);
      renders.push({ scale, width: res.width, height: res.height, ms: Math.round(res.ms) });
    } catch (e) { renders.push({ scale, error: (e as Error).message }); }
  }
  r.dispose();
  return { candidate: cand.name, renders, files };
}
(window.simock as Record<string, unknown>).runPhotopea = runPhotopea;
