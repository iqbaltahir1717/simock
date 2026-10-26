// Which Photoshop features the native renderer reproduces, plus the pure maths for them.

import type { Layer, LevelsAdjustment, LevelsAdjustmentChannel, PlacedLayerFilter } from 'ag-psd';

/** Layer effects the native renderer draws. Others are reported as unsupported. */
export const SUPPORTED_EFFECTS = new Set(['solidFill']);
/** Adjustment layers the native renderer applies. */
export const SUPPORTED_ADJUSTMENTS = new Set(['levels']);

/** Names of enabled layer effects (e.g. "dropShadow", "solidFill"). */
export function enabledEffects(layer: Layer): string[] {
  const fx = layer.effects as Record<string, unknown> | undefined;
  if (!fx || fx.disabled) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(fx)) {
    if (key === 'disabled' || key === 'scale') continue;
    const list = Array.isArray(value) ? value : [value];
    if (list.some((e) => e && typeof e === 'object' && (e as { enabled?: boolean }).enabled !== false)) out.push(key);
  }
  return out;
}

export function unsupportedEffects(layer: Layer): string[] {
  return enabledEffects(layer).filter((e) => !SUPPORTED_EFFECTS.has(e));
}

/**
 * 256-entry lookup tables (R, G, B) for a Levels adjustment. Composite channel is applied, then
 * the per-channel entries; that order is unverified against Photoshop for multi-channel Levels.
 */
export function levelsLuts(adj: LevelsAdjustment): [Uint8Array, Uint8Array, Uint8Array] {
  const one = (c?: LevelsAdjustmentChannel) => {
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      if (!c) { lut[v] = v; continue; }
      const inB = c.shadowInput, inW = Math.max(c.highlightInput, inB + 1);
      let x = Math.min(1, Math.max(0, (v - inB) / (inW - inB)));
      const gamma = c.midtoneInput > 0 ? c.midtoneInput : 1;
      x = Math.pow(x, 1 / gamma);
      lut[v] = Math.round(c.shadowOutput + x * (c.highlightOutput - c.shadowOutput));
    }
    return lut;
  };
  const ch = adj.channels ?? [];
  const master = one(ch[0]);
  const per = [1, 2, 3].map((i) => one(ch[i]));
  return [0, 1, 2].map((i) => per[i].map((_, v) => per[i][master[v]])) as [Uint8Array, Uint8Array, Uint8Array];
}

/**
 * CSS blur() takes a standard deviation; Photoshop's Gaussian Blur takes a "radius".
 * Calibrated against a real Photoshop file (see PROGRESS.md).
 */
export let GAUSSIAN_SIGMA_PER_RADIUS = 1;
export function setGaussianCalibration(v: number) { GAUSSIAN_SIGMA_PER_RADIUS = v; }

export interface SmartFilterPlan { blurRadius: number; unsupported: string[] }

/** Smart filters the native renderer can re-apply to new content: Gaussian Blur only. */
export function smartFilterPlan(filter: PlacedLayerFilter | undefined): SmartFilterPlan {
  const plan: SmartFilterPlan = { blurRadius: 0, unsupported: [] };
  if (!filter || !filter.enabled) return plan;
  for (const f of filter.list ?? []) {
    if (!f.enabled) continue;
    if (f.type === 'gaussian blur' && f.opacity >= 1 && f.blendMode === 'normal') plan.blurRadius += f.filter.radius.value;
    else plan.unsupported.push(f.name.replace(/\.\.\.$/, ''));
  }
  return plan;
}
