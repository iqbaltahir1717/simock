// Native renderer: recomposites the PSD layer stack in the browser and swaps the
// target Smart Object's pixels for the warped design. Supports the features mockups
// usually rely on (stacking order, opacity, fill opacity, common blend modes, raster
// masks, clipping groups, groups, perspective placeholders). Anything else is reported
// by inspectPsd and in each render's warnings rather than silently ignored.

import type { Layer, Psd } from 'ag-psd';
import { quadFromTransform, quadScaleFactor, scaleQuad } from '../../geometry';
import { checkOutputSize, mimeFor, outputSize } from '../../export';
import { designExportScale, placementMatrix } from '../../placement';
import { CANVAS_BLEND, findLayer, inspectPsd, isGroup, loadPsd, smartObjectInstances, type MockupInspection } from '../../psd/inspect';
import type { MockupRenderer, RenderRequest, RenderResult } from '../types';
import { GAUSSIAN_SIGMA_PER_RADIUS, SUPPORTED_ADJUSTMENTS, SUPPORTED_EFFECTS, enabledEffects, levelsLuts, smartFilterPlan } from '../../psd/features';
import { maxTextureSize, warpInto } from './warp';

type Ctx = CanvasRenderingContext2D;

export function createSurface(w: number, h: number): Ctx {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: false });
  if (!ctx || c.width !== w || c.height !== h) throw new Error(`Could not allocate a ${w}×${h} canvas. Try a smaller export scale.`);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

function release(ctx: Ctx) { ctx.canvas.width = 0; ctx.canvas.height = 0; }

const opacityOf = (l: Layer) => (l.opacity ?? 1) * (l.fillOpacity ?? 1);
const blendOf = (l: Layer): GlobalCompositeOperation => (l.blendMode && CANVAS_BLEND[l.blendMode]) || 'source-over';

/** Layers whose pixels are replaced at render time (every instance of the target Smart Object). */
type Override = Map<Layer, (ctx: Ctx) => void>;

export class Compositor {
  private maskCache = new WeakMap<Layer, HTMLCanvasElement>();
  constructor(private psd: Psd) {}

  render(scale: number, override?: Override): HTMLCanvasElement {
    const { width, height } = outputSize(this.psd.width, this.psd.height, scale);
    const out = createSurface(width, height);
    this.drawLayers(out, this.psd.children ?? [], scale, override);
    return out.canvas;
  }

  private drawLayers(ctx: Ctx, layers: Layer[], s: number, ov?: Override) {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (l.clipping && i > 0) continue; // drawn with its base below
      const clipped: Layer[] = [];
      for (let j = i + 1; j < layers.length && layers[j].clipping; j++) clipped.push(layers[j]);
      if (l.hidden) continue;
      if (l.adjustment) {
        // Adjustment layers act on everything already composited below them in this stack.
        if (SUPPORTED_ADJUSTMENTS.has(l.adjustment.type)) this.applyAdjustment(ctx, l);
        continue;
      }
      const visibleClipped = clipped.filter((c) => !c.hidden);
      const hasMask = !!l.mask && !l.mask.disabled && !!(l.mask.canvas || l.mask.defaultColor === 0);
      const group = isGroup(l);
      const effects = enabledEffects(l).filter((e) => SUPPORTED_EFFECTS.has(e));

      if (group && l.blendMode === 'pass through' && opacityOf(l) >= 1 && !hasMask && !visibleClipped.length) {
        this.drawLayers(ctx, l.children!, s, ov);
        continue;
      }
      if (!group && !hasMask && !visibleClipped.length && !effects.length) {
        ctx.save();
        ctx.globalAlpha = opacityOf(l);
        ctx.globalCompositeOperation = blendOf(l);
        this.drawContent(ctx, l, s, ov);
        ctx.restore();
        continue;
      }

      const W = ctx.canvas.width, H = ctx.canvas.height;
      const base = createSurface(W, H);
      if (group) this.drawLayers(base, l.children!, s, ov);
      else this.drawContent(base, l, s, ov);
      if (effects.length) this.applyEffects(base, l);
      if (hasMask) this.applyMask(base, l);

      if (visibleClipped.length) {
        const baseAlpha = createSurface(W, H);
        baseAlpha.drawImage(base.canvas, 0, 0);
        for (const c of visibleClipped) {
          if (c.adjustment) {
            if (SUPPORTED_ADJUSTMENTS.has(c.adjustment.type)) this.applyAdjustment(base, c, baseAlpha.canvas);
            continue;
          }
          const layer = createSurface(W, H);
          if (isGroup(c)) this.drawLayers(layer, c.children!, s, ov); else this.drawContent(layer, c, s, ov);
          if (c.mask && !c.mask.disabled) this.applyMask(layer, c);
          layer.globalCompositeOperation = 'destination-in';
          layer.drawImage(baseAlpha.canvas, 0, 0);
          base.save();
          base.globalAlpha = opacityOf(c);
          base.globalCompositeOperation = blendOf(c);
          base.drawImage(layer.canvas, 0, 0);
          base.restore();
          release(layer);
        }
        release(baseAlpha);
      }

      ctx.save();
      // Fill opacity affects the layer's pixels but not its effects; with supported effects we
      // approximate by using layer opacity only.
      ctx.globalAlpha = effects.length ? (l.opacity ?? 1) : opacityOf(l);
      ctx.globalCompositeOperation = blendOf(l);
      ctx.drawImage(base.canvas, 0, 0);
      ctx.restore();
      release(base);
    }
  }

  /** Applies a supported adjustment layer to the pixels already in `ctx`, through its mask and opacity. */
  private applyAdjustment(ctx: Ctx, l: Layer, clip?: HTMLCanvasElement) {
    const adj = l.adjustment!;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const out = createSurface(W, H);
    out.drawImage(ctx.canvas, 0, 0);
    if (adj.type === 'levels') {
      const [r, g, b] = levelsLuts(adj);
      // Process in strips to bound peak memory on large outputs.
      const strip = Math.max(1, Math.floor(4_000_000 / W));
      for (let y = 0; y < H; y += strip) {
        const h = Math.min(strip, H - y);
        const img = out.getImageData(0, y, W, h);
        const d = img.data;
        for (let p = 0; p < d.length; p += 4) {
          if (!d[p + 3]) continue;
          d[p] = r[d[p]]; d[p + 1] = g[d[p + 1]]; d[p + 2] = b[d[p + 2]];
        }
        out.putImageData(img, 0, y);
      }
    }
    if (l.mask && !l.mask.disabled) this.applyMask(out, l);
    if (clip) { out.globalCompositeOperation = 'destination-in'; out.drawImage(clip, 0, 0); }
    ctx.save();
    ctx.globalAlpha = opacityOf(l);
    ctx.globalCompositeOperation = blendOf(l);
    ctx.drawImage(out.canvas, 0, 0);
    ctx.restore();
    release(out);
  }

  /** Supported layer effects, applied to the layer's own pixels in `ctx`. */
  private applyEffects(ctx: Ctx, l: Layer) {
    const fx = l.effects!;
    for (const fill of fx.solidFill ?? []) {
      if (fill.enabled === false || !fill.color || !('r' in fill.color)) continue;
      const W = ctx.canvas.width, H = ctx.canvas.height;
      const ov = createSurface(W, H);
      const c = fill.color as { r: number; g: number; b: number };
      ov.fillStyle = `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
      ov.fillRect(0, 0, W, H);
      ov.globalCompositeOperation = 'destination-in';
      ov.drawImage(ctx.canvas, 0, 0);
      ctx.save();
      ctx.globalAlpha = fill.opacity ?? 1;
      ctx.globalCompositeOperation = (fill.blendMode && CANVAS_BLEND[fill.blendMode]) || 'source-over';
      ctx.drawImage(ov.canvas, 0, 0);
      ctx.restore();
      release(ov);
    }
  }

  private drawContent(ctx: Ctx, l: Layer, s: number, ov?: Override) {
    const replace = ov?.get(l);
    if (replace) { replace(ctx); return; }
    if (!l.canvas) return;
    ctx.drawImage(l.canvas, (l.left ?? 0) * s, (l.top ?? 0) * s, l.canvas.width * s, l.canvas.height * s);
  }

  /** Converts the grey-level layer mask into an alpha mask at document size (cached), then applies it. */
  private applyMask(ctx: Ctx, l: Layer) {
    const m = l.mask!;
    let alpha = this.maskCache.get(l);
    if (!alpha) {
      const W = this.psd.width, H = this.psd.height;
      const a = createSurface(W, H);
      a.fillStyle = `rgba(0,0,0,${(m.defaultColor ?? 0) / 255})`;
      a.fillRect(0, 0, W, H);
      if (m.canvas && m.canvas.width && m.canvas.height) {
        const src = m.canvas.getContext('2d')!.getImageData(0, 0, m.canvas.width, m.canvas.height);
        const d = src.data;
        for (let p = 0; p < d.length; p += 4) { d[p + 3] = d[p]; d[p] = d[p + 1] = d[p + 2] = 0; }
        const ox = (m.left ?? 0) + (m.positionRelativeToLayer ? l.left ?? 0 : 0);
        const oy = (m.top ?? 0) + (m.positionRelativeToLayer ? l.top ?? 0 : 0);
        a.putImageData(src, ox, oy);
      }
      alpha = a.canvas;
      this.maskCache.set(l, alpha);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(alpha, 0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }
}

export interface FidelityReport { meanAbsError: number; pctPixelsOver8: number; pctPixelsOver32: number; diff: HTMLCanvasElement }

/** Compares two equally sized canvases. Diff image: grey = original, red = difference. */
export function compareCanvases(a: HTMLCanvasElement, b: HTMLCanvasElement): FidelityReport {
  const w = a.width, h = a.height;
  const da = a.getContext('2d')!.getImageData(0, 0, w, h).data;
  const db = b.getContext('2d')!.getImageData(0, 0, w, h).data;
  const diff = createSurface(w, h);
  const out = diff.createImageData(w, h);
  let sum = 0, over8 = 0, over32 = 0;
  for (let p = 0; p < da.length; p += 4) {
    // Compare colours over white so fully transparent pixels compare equal regardless of RGB.
    let max = 0;
    for (let c = 0; c < 3; c++) {
      const va = (da[p + c] * da[p + 3]) / 255 + 255 - da[p + 3];
      const vb = (db[p + c] * db[p + 3]) / 255 + 255 - db[p + 3];
      const e = Math.abs(va - vb); sum += e; if (e > max) max = e;
    }
    if (max > 8) over8++; if (max > 32) over32++;
    const g = ((da[p] + da[p + 1] + da[p + 2]) / 3) * 0.35;
    out.data[p] = Math.min(255, g + max * 4); out.data[p + 1] = g; out.data[p + 2] = g; out.data[p + 3] = 255;
  }
  diff.putImageData(out, 0, 0);
  const n = w * h;
  return { meanAbsError: sum / (n * 3), pctPixelsOver8: (100 * over8) / n, pctPixelsOver32: (100 * over32) / n, diff: diff.canvas };
}

export async function encodeCanvas(canvas: HTMLCanvasElement, format: 'png' | 'jpeg', quality: number, background: string): Promise<Blob> {
  let src = canvas;
  if (format === 'jpeg') {
    const bg = createSurface(canvas.width, canvas.height);
    bg.fillStyle = background; bg.fillRect(0, 0, canvas.width, canvas.height);
    bg.drawImage(canvas, 0, 0);
    src = bg.canvas;
  }
  const blob = await new Promise<Blob | null>((res) => src.toBlob(res, mimeFor(format), format === 'jpeg' ? quality : undefined));
  if (src !== canvas) release(src.getContext('2d')!);
  if (!blob) throw new Error('The browser could not encode the image (likely out of memory). Try a smaller scale.');
  return blob;
}

export class NativeRenderer implements MockupRenderer {
  readonly id = 'native' as const;
  readonly label = 'Built-in (runs locally)';
  readonly thirdParty = false;
  psd?: Psd;
  inspection?: MockupInspection;
  private compositor?: Compositor;

  async open(file: ArrayBuffer) {
    this.psd = loadPsd(file);
    this.compositor = new Compositor(this.psd);
    this.inspection = inspectPsd(this.psd);
    return this.inspection;
  }

  /** Renders the untouched document to check how closely we reproduce Photoshop's own composite. */
  selfCheck(): FidelityReport | undefined {
    if (!this.psd?.canvas || !this.compositor) return undefined;
    return compareCanvases(this.psd.canvas, this.compositor.render(1));
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    const t0 = performance.now();
    const psd = this.psd, comp = this.compositor, insp = this.inspection;
    if (!psd || !comp || !insp) throw new Error('Open a mockup first.');
    const size = checkOutputSize(psd.width, psd.height, req.scale);
    if (!size.ok) throw new Error(size.reason);

    const layer = findLayer(psd, req.target);
    if (!layer?.placedLayer) throw new Error('The saved placeholder layer was not found in this PSD. Choose it again in template setup.');
    const pl = layer.placedLayer;
    const slot = { width: pl.width ?? 0, height: pl.height ?? 0 };
    if (!slot.width || !slot.height) throw new Error('The placeholder has no size information.');
    const quad = quadFromTransform(pl.nonAffineTransform ?? pl.transform);

    const warnings = insp.issues.filter((i) => i.severity !== 'info').map((i) => (i.layer ? `${i.layer}: ${i.message}` : i.message));
    const cand = insp.candidates.find((c) => c.ref.layerId === layer.id && c.name === layer.name);
    cand?.issues.filter((i) => i.severity !== 'info').forEach((i) => warnings.push(`Placeholder: ${i.message}`));
    if (req.scale > 1) warnings.push(`Mockup photo pixels are upscaled ${req.scale}× (the PSD has no more detail); your design is rendered at full resolution.`);

    // Content resolution: match output pixels along the quad's longest edge, within GPU limits.
    let k = Math.max(0.05, req.scale * quadScaleFactor(quad, slot.width, slot.height));
    const maxTex = maxTextureSize();
    if (Math.max(slot.width, slot.height) * k > maxTex) {
      k = maxTex / Math.max(slot.width, slot.height);
      warnings.push(`Design resolution capped by the GPU texture limit (${maxTex}px).`);
    }
    const exportScale = designExportScale(req.design, slot, req.placement, k);
    const img = await req.design.getImage(exportScale);
    if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const content = createSurface(Math.max(1, Math.round(slot.width * k)), Math.max(1, Math.round(slot.height * k)));
    const M = placementMatrix(req.design, slot, req.placement);
    const ix = img.width / req.design.width, iy = img.height / req.design.height;
    content.setTransform(k * M[0] / ix, k * M[1] / ix, k * M[2] / iy, k * M[3] / iy, k * M[4], k * M[5]);
    content.drawImage(img, 0, 0);

    // Every layer that shares this Smart Object's contents is updated, as in Photoshop.
    const overrides: Override = new Map();
    for (const inst of smartObjectInstances(psd, pl.id)) {
      const ipl = inst.placedLayer!;
      const iquad = scaleQuad(quadFromTransform(ipl.nonAffineTransform ?? ipl.transform), req.scale);
      const blur = smartFilterPlan(ipl.filter).blurRadius * GAUSSIAN_SIGMA_PER_RADIUS * req.scale;
      overrides.set(inst, (ctx) => {
        if (!blur) { warpInto(ctx, content.canvas, iquad); return; }
        const tmp = createSurface(ctx.canvas.width, ctx.canvas.height);
        warpInto(tmp, content.canvas, iquad);
        ctx.save();
        ctx.filter = `blur(${blur}px)`;
        ctx.drawImage(tmp.canvas, 0, 0);
        ctx.restore();
        release(tmp);
      });
      if (inst !== layer) {
        const extra = smartFilterPlan(ipl.filter).unsupported;
        warnings.push(`"${inst.name}" shares this placeholder and is updated too${extra.length ? `, but its smart filters (${extra.join(', ')}) are not re-applied` : ''}.`);
      }
    }
    const canvas = comp.render(req.scale, overrides);
    release(content);

    let blob: Blob | undefined;
    if (req.encode) blob = await encodeCanvas(canvas, req.encode.format, req.encode.jpegQuality, req.encode.jpegBackground);
    return { canvas, blob, width: canvas.width, height: canvas.height, warnings, ms: performance.now() - t0 };
  }

  dispose() { this.psd = undefined; this.compositor = undefined; this.inspection = undefined; }
}
