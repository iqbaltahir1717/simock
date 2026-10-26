// Reads a PSD with ag-psd and reports Smart Object candidates plus everything the
// renderers cannot reproduce. ag-psd is a parser, not a Photoshop renderer: it gives us
// layer pixels, masks and transforms, and leaves compositing to us.

import { readPsd, type Layer, type Psd, type BlendMode, type Warp } from 'ag-psd';
import { isAffineQuad, quadFromTransform, type Quad } from '../geometry';

export type Severity = 'info' | 'warn' | 'block';
export interface Issue { severity: Severity; code: string; message: string; layer?: string }

/** Stable identity of a layer: Photoshop layer id first, name path and index path as fallbacks. */
export interface LayerRef { layerId?: number; path: string[]; indexPath: number[] }

export interface SmartObjectCandidate {
  ref: LayerRef;
  name: string;
  /** Smart Object document size in pixels (the placeholder's own coordinate system). */
  width: number;
  height: number;
  /** Where the placeholder corners land in the mockup document (TL, TR, BR, BL). */
  quad: Quad;
  perspective: boolean;
  warpStyle?: string;
  linked: boolean;
  nested: boolean;
  hidden: boolean;
  clippedLayersAbove: number;
  issues: Issue[];
}

export interface MockupInspection {
  width: number;
  height: number;
  colorMode: string;
  bitsPerChannel: number;
  hasComposite: boolean;
  layerCount: number;
  candidates: SmartObjectCandidate[];
  /** Document-level features the native renderer cannot reproduce. */
  issues: Issue[];
}

export const CANVAS_BLEND: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: 'source-over', 'pass through': 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
  darken: 'darken', lighten: 'lighten', 'color dodge': 'color-dodge', 'color burn': 'color-burn',
  'hard light': 'hard-light', 'soft light': 'soft-light', difference: 'difference', exclusion: 'exclusion',
  hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity', 'linear dodge': 'lighter',
};
/** Canvas implements these with W3C formulas that differ slightly from Photoshop's. */
const APPROX_BLEND = new Set<BlendMode>(['soft light', 'linear dodge', 'hue', 'saturation', 'color', 'luminosity']);

const COLOR_MODES = ['Bitmap', 'Grayscale', 'Indexed', 'RGB', 'CMYK', '?', '?', 'Multichannel', 'Duotone', 'Lab'];

export function loadPsd(buffer: ArrayBuffer, withPixels = true): Psd {
  return readPsd(buffer, {
    skipLayerImageData: !withPixels,
    skipCompositeImageData: !withPixels,
    skipThumbnail: true,
    skipLinkedFilesData: false,
    useImageData: false,
  });
}

export function hasEnabledEffects(layer: Layer): boolean {
  const fx = layer.effects as Record<string, unknown> | undefined;
  if (!fx || fx.disabled) return false;
  for (const [key, value] of Object.entries(fx)) {
    if (key === 'disabled' || key === 'scale') continue;
    const list = Array.isArray(value) ? value : [value];
    if (list.some((e) => e && typeof e === 'object' && (e as { enabled?: boolean }).enabled !== false)) return true;
  }
  return false;
}

/** Photoshop often stores an untouched warp: a regular mesh over the bounds, or a preset with value 0. */
export function isIdentityWarp(w: Warp | undefined): boolean {
  if (!w || !w.style || w.style === 'none') return true;
  if (w.style !== 'custom') return !w.value;
  const pts = w.customEnvelopeWarp?.meshPoints, b = w.bounds;
  if (!pts || !b) return false;
  const left = b.left.value, top = b.top.value, right = b.right.value, bottom = b.bottom.value;
  const nu = w.uOrder ?? 4, nv = w.vOrder ?? 4;
  if (pts.length !== nu * nv) return false;
  return pts.every((p, i) => {
    const u = i % nu, v = Math.floor(i / nu);
    return Math.abs(p.x - (left + ((right - left) * u) / (nu - 1))) < 0.5 && Math.abs(p.y - (top + ((bottom - top) * v) / (nv - 1))) < 0.5;
  });
}

export function isGroup(layer: Layer) { return Array.isArray(layer.children); }

/** Walks layers bottom-to-top (ag-psd order) with name/index paths. */
export function walk(layers: Layer[] | undefined, fn: (l: Layer, path: string[], idx: number[], siblings: Layer[], i: number) => void, path: string[] = [], idx: number[] = []) {
  (layers ?? []).forEach((l, i) => {
    const p = [...path, l.name ?? `Layer ${i}`], ix = [...idx, i];
    fn(l, p, ix, layers!, i);
    if (l.children) walk(l.children, fn, p, ix);
  });
}

export function findLayer(psd: Psd, ref: LayerRef): Layer | undefined {
  let byId: Layer | undefined, byPath: Layer | undefined;
  walk(psd.children, (l, path) => {
    if (ref.layerId !== undefined && l.id === ref.layerId) byId = l;
    if (!byPath && path.join('\u0000') === ref.path.join('\u0000')) byPath = l;
  });
  if (byId) return byId;
  if (byPath) return byPath;
  let node: Layer | undefined; let list = psd.children;
  for (const i of ref.indexPath) { node = list?.[i]; list = node?.children; }
  return node;
}

function embeddedHasSmartObjects(data: Uint8Array | undefined): boolean {
  if (!data || data.length < 4 || String.fromCharCode(data[0], data[1], data[2], data[3]) !== '8BPS') return false;
  try {
    const inner = readPsd(data.slice().buffer, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
    let found = false;
    walk(inner.children, (l) => { if (l.placedLayer) found = true; });
    return found;
  } catch { return false; }
}

export function inspectPsd(psd: Psd): MockupInspection {
  const issues: Issue[] = [];
  const candidates: SmartObjectCandidate[] = [];
  let layerCount = 0;
  const colorMode = COLOR_MODES[psd.colorMode ?? 3] ?? 'unknown';
  const bits = psd.bitsPerChannel ?? 8;

  if (colorMode !== 'RGB') issues.push({ severity: colorMode === 'CMYK' || colorMode === 'Grayscale' ? 'warn' : 'block', code: 'color-mode', message: `${colorMode} document. Colours are converted to RGB approximately and the embedded colour profile is ignored.` });
  if (bits !== 8) issues.push({ severity: 'warn', code: 'bit-depth', message: `${bits}-bit document is rendered in 8-bit.` });
  if (!psd.canvas) issues.push({ severity: 'info', code: 'no-composite', message: 'No stored composite (saved without Maximize Compatibility), so fidelity cannot be self-checked.' });

  walk(psd.children, (l, path, idx, siblings, i) => {
    layerCount++;
    const name = path.join(' / ');
    const visible = !l.hidden;
    if (visible && l.adjustment) issues.push({ severity: 'warn', code: 'adjustment', layer: name, message: `Adjustment layer (${l.adjustment.type}) is not reproduced by the native renderer.` });
    if (visible && hasEnabledEffects(l) && !l.placedLayer) issues.push({ severity: 'warn', code: 'effects', layer: name, message: 'Layer effects (shadows, glows, strokes…) are not reproduced by the native renderer.' });
    if (visible && l.blendMode && !CANVAS_BLEND[l.blendMode]) issues.push({ severity: 'warn', code: 'blend', layer: name, message: `Blend mode "${l.blendMode}" is approximated as normal.` });
    else if (visible && l.blendMode && APPROX_BLEND.has(l.blendMode)) issues.push({ severity: 'info', code: 'blend-approx', layer: name, message: `Blend mode "${l.blendMode}" uses a browser formula that differs slightly from Photoshop.` });
    if (visible && l.vectorMask && !l.vectorFill) issues.push({ severity: 'warn', code: 'vector-mask', layer: name, message: 'Vector mask is ignored by the native renderer.' });
    if (visible && l.knockout) issues.push({ severity: 'warn', code: 'knockout', layer: name, message: 'Knockout is not supported.' });
    if (visible && isGroup(l) && l.blendMode === 'pass through' && (l.opacity ?? 1) < 1) issues.push({ severity: 'info', code: 'pass-through', layer: name, message: 'Pass-through group with reduced opacity is rendered as an isolated group.' });
    if (visible && !isGroup(l) && !l.canvas && !l.adjustment && (l.right ?? 0) > (l.left ?? 0)) issues.push({ severity: 'warn', code: 'no-pixels', layer: name, message: 'Layer has no stored pixels (e.g. a fill layer) and will be blank.' });

    if (!l.placedLayer) return;
    const pl = l.placedLayer;
    const quad = quadFromTransform(pl.nonAffineTransform ?? pl.transform);
    const lf = psd.linkedFiles?.find((f) => f.id === pl.id);
    const soIssues: Issue[] = [];
    const linked = !!pl.external || !!lf?.linkedFile || (!lf?.data && !!lf);
    if (linked) soIssues.push({ severity: 'info', code: 'linked', message: 'Linked (external) Smart Object. Its source file is not inside the PSD; replacing it embeds the new content.' });
    const nested = embeddedHasSmartObjects(lf?.data);
    if (nested) soIssues.push({ severity: 'warn', code: 'nested', message: 'Contains nested Smart Objects. Only this outer object is replaced.' });
    const warpStyle = isIdentityWarp(pl.warp) ? undefined : pl.warp?.style;
    if (warpStyle) soIssues.push({ severity: 'warn', code: 'warp', message: `Warp "${warpStyle}" is approximated with a perspective transform by the native renderer.` });
    if (pl.filter) soIssues.push({ severity: 'warn', code: 'smart-filter', message: 'Smart filters are applied to the original content only. The native renderer cannot re-apply them to your design.' });
    if (hasEnabledEffects(l)) soIssues.push({ severity: 'warn', code: 'so-effects', message: 'Layer effects on the placeholder are not reproduced by the native renderer.' });
    if (pl.type === 'vector') soIssues.push({ severity: 'info', code: 'vector-so', message: 'Vector Smart Object (e.g. from Illustrator). Replacement content is raster.' });
    if (!pl.width || !pl.height) soIssues.push({ severity: 'block', code: 'so-size', message: 'Smart Object size is missing.' });

    let clipped = 0;
    for (let j = i + 1; j < siblings.length && siblings[j].clipping; j++) clipped++;

    candidates.push({
      ref: { layerId: l.id, path, indexPath: idx }, name: l.name ?? 'Smart Object',
      width: pl.width ?? 0, height: pl.height ?? 0, quad,
      perspective: !isAffineQuad(quad), warpStyle, linked, nested, hidden: !!l.hidden, clippedLayersAbove: clipped, issues: soIssues,
    });
  });

  // Larger, visible placeholders first: usually the screen.
  candidates.sort((a, b) => Number(a.hidden) - Number(b.hidden) || b.width * b.height - a.width * a.height);
  return { width: psd.width, height: psd.height, colorMode, bitsPerChannel: bits, hasComposite: !!psd.canvas, layerCount, candidates, issues };
}
