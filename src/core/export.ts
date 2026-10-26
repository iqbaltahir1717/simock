// Export presets and resource limits. Pure functions only.

export const SCALE_PRESETS = [0.5, 0.75, 1, 2, 4] as const;
export type ScalePreset = (typeof SCALE_PRESETS)[number];
export type ExportFormat = 'png' | 'jpeg';

export interface ExportOptions {
  format: ExportFormat;
  /** 1 = the mockup document's native pixel size. */
  scale: number;
  /** 0..1, JPG only. */
  jpegQuality: number;
  /** CSS colour used behind transparent pixels in JPG. PNG keeps transparency. */
  jpegBackground: string;
}

export const DEFAULT_EXPORT: ExportOptions = { format: 'png', scale: 1, jpegQuality: 0.92, jpegBackground: '#ffffff' };

export function outputSize(docWidth: number, docHeight: number, scale: number) {
  return { width: Math.max(1, Math.round(docWidth * scale)), height: Math.max(1, Math.round(docHeight * scale)) };
}

/**
 * Chromium limits (Figma desktop and browser both run Chromium-family engines for plugin UIs):
 * 32767 px per side and 268,435,456 px total for a 2D canvas. Memory usually runs out first,
 * so we also budget for the intermediate surfaces the compositor keeps alive.
 */
export const LIMITS = {
  maxSide: 32767,
  maxArea: 268_435_456,
  /** Bytes we allow the compositor to hold at once (default ~1.5 GB). */
  memoryBudget: 1.5 * 1024 ** 3,
  /** Full-document RGBA surfaces alive at peak: output, layer, clip, group. */
  peakSurfaces: 4,
};

export interface SizeCheck { ok: boolean; width: number; height: number; estimatedBytes: number; reason?: string }

export function checkOutputSize(docWidth: number, docHeight: number, scale: number, limits = LIMITS): SizeCheck {
  const { width, height } = outputSize(docWidth, docHeight, scale);
  const estimatedBytes = width * height * 4 * limits.peakSurfaces;
  const mp = ((width * height) / 1e6).toFixed(1);
  if (width > limits.maxSide || height > limits.maxSide)
    return { ok: false, width, height, estimatedBytes, reason: `${width}×${height} exceeds the ${limits.maxSide}px canvas side limit. Choose a smaller scale.` };
  if (width * height > limits.maxArea)
    return { ok: false, width, height, estimatedBytes, reason: `${mp} MP exceeds the browser canvas area limit (268 MP). Choose a smaller scale.` };
  if (estimatedBytes > limits.memoryBudget)
    return { ok: false, width, height, estimatedBytes, reason: `${mp} MP needs about ${(estimatedBytes / 1024 ** 3).toFixed(1)} GB while rendering, above the ${(limits.memoryBudget / 1024 ** 3).toFixed(1)} GB budget. Choose a smaller scale.` };
  return { ok: true, width, height, estimatedBytes };
}

export function mimeFor(format: ExportFormat) {
  return format === 'png' ? 'image/png' : 'image/jpeg';
}
