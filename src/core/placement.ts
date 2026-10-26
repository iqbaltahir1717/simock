// Placement of the design inside the Smart Object placeholder.
// Every value lives in the placeholder's own pixel space (the Smart Object document),
// so the mockup's perspective transform is applied after placement, never before.

import { Affine, multiplyAffine } from './geometry';

export type FitMode = 'fit' | 'fill' | 'stretch';

export interface Placement {
  mode: FitMode;
  /** Multiplier on top of the fit/fill base scale. 1 = exactly fit/fill. */
  scale: number;
  /** Offset of the design centre from the placeholder centre, in placeholder pixels. */
  offsetX: number;
  offsetY: number;
  /** Degrees, clockwise. */
  rotation: number;
  /** When false, 'stretch' fills both axes independently. Ignored for fit/fill. */
  lockAspect: boolean;
}

export const DEFAULT_PLACEMENT: Placement = { mode: 'fill', scale: 1, offsetX: 0, offsetY: 0, rotation: 0, lockAspect: true };

export function centered(p: Placement): Placement {
  return { ...p, offsetX: 0, offsetY: 0 };
}

export interface Size { width: number; height: number }

/** Base scale on each axis for the design to fit/fill the placeholder. */
export function baseScale(design: Size, slot: Size, mode: FitMode, lockAspect = true): { sx: number; sy: number } {
  const rx = slot.width / design.width, ry = slot.height / design.height;
  if (mode === 'stretch' && !lockAspect) return { sx: rx, sy: ry };
  const s = mode === 'fit' ? Math.min(rx, ry) : Math.max(rx, ry);
  return { sx: s, sy: s };
}

/** Affine mapping design pixels -> placeholder pixels. */
export function placementMatrix(design: Size, slot: Size, p: Placement): Affine {
  const { sx, sy } = baseScale(design, slot, p.mode, p.lockAspect);
  const r = (p.rotation * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const toOrigin: Affine = [1, 0, 0, 1, -design.width / 2, -design.height / 2];
  const scale: Affine = [sx * p.scale, 0, 0, sy * p.scale, 0, 0];
  const rotate: Affine = [cos, sin, -sin, cos, 0, 0];
  const toSlot: Affine = [1, 0, 0, 1, slot.width / 2 + p.offsetX, slot.height / 2 + p.offsetY];
  return multiplyAffine(toSlot, multiplyAffine(rotate, multiplyAffine(scale, toOrigin)));
}

/**
 * Raster scale to request from Figma so one design pixel lands on roughly one
 * output pixel. `contentScale` is placeholder-pixels -> rendered-content-pixels.
 */
export function designExportScale(design: Size, slot: Size, p: Placement, contentScale: number): number {
  const { sx, sy } = baseScale(design, slot, p.mode, p.lockAspect);
  return Math.max(sx, sy) * p.scale * contentScale;
}
