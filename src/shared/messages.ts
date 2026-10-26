// Message protocol between the Figma main thread (src/plugin) and the UI iframe (src/ui).
// Both sides validate incoming messages; nothing is trusted by shape alone.

import type { LayerRef } from '../core/psd/inspect';
import type { Placement } from '../core/placement';

export interface FrameInfo { id: string; name: string; width: number; height: number; preview: Uint8Array }

export interface TemplateConfig {
  /** SHA-256 of the PSD file. */
  hash: string;
  fileName: string;
  renderer: 'native' | 'photopea';
  target: LayerRef & { name: string; width: number; height: number };
  placement: Placement;
  updatedAt: number;
}

export type PluginToUi =
  | { type: 'selection'; frame: FrameInfo | null; reason?: string }
  | { type: 'design-image'; requestId: number; bytes: Uint8Array; scale: number }
  | { type: 'design-error'; requestId: number; message: string }
  | { type: 'templates'; templates: Record<string, TemplateConfig> };

export type UiToPlugin =
  | { type: 'refresh' }
  | { type: 'export-design'; requestId: number; nodeId: string; scale: number }
  | { type: 'save-template'; template: TemplateConfig }
  | { type: 'load-templates' }
  | { type: 'notify'; message: string; error?: boolean };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;

function isPlacement(p: unknown): p is Placement {
  return isObj(p) && ['fit', 'fill', 'stretch'].includes(p.mode as string) && isNum(p.scale) && p.scale > 0 && p.scale < 100
    && isNum(p.offsetX) && isNum(p.offsetY) && isNum(p.rotation) && typeof p.lockAspect === 'boolean';
}

export function isTemplate(t: unknown): t is TemplateConfig {
  if (!isObj(t) || !isStr(t.hash, 128) || !/^[0-9a-f]{64}$/.test(t.hash) || !isStr(t.fileName, 512)) return false;
  if (t.renderer !== 'native' && t.renderer !== 'photopea') return false;
  const g = t.target;
  if (!isObj(g) || !isStr(g.name, 512) || !isNum(g.width) || !isNum(g.height)) return false;
  if (!Array.isArray(g.path) || !g.path.every((s) => isStr(s, 512)) || !Array.isArray(g.indexPath) || !g.indexPath.every(isNum)) return false;
  if (g.layerId !== undefined && !isNum(g.layerId)) return false;
  return isPlacement(t.placement) && isNum(t.updatedAt);
}

export function parseUiMessage(m: unknown): UiToPlugin | null {
  if (!isObj(m)) return null;
  switch (m.type) {
    case 'refresh': case 'load-templates': return { type: m.type };
    case 'export-design':
      return isNum(m.requestId) && isStr(m.nodeId, 200) && isNum(m.scale) && m.scale > 0 ? { type: 'export-design', requestId: m.requestId, nodeId: m.nodeId, scale: m.scale } : null;
    case 'save-template': return isTemplate(m.template) ? { type: 'save-template', template: m.template } : null;
    case 'notify': return isStr(m.message, 300) ? { type: 'notify', message: m.message, error: m.error === true } : null;
    default: return null;
  }
}

export function parsePluginMessage(m: unknown): PluginToUi | null {
  if (!isObj(m)) return null;
  switch (m.type) {
    case 'selection': {
      if (m.frame === null) return { type: 'selection', frame: null, reason: isStr(m.reason) ? m.reason : undefined };
      const f = m.frame;
      return isObj(f) && isStr(f.id, 200) && isStr(f.name, 2000) && isNum(f.width) && isNum(f.height) && f.preview instanceof Uint8Array ? { type: 'selection', frame: f as unknown as FrameInfo } : null;
    }
    case 'design-image': return isNum(m.requestId) && isNum(m.scale) && m.bytes instanceof Uint8Array ? (m as PluginToUi) : null;
    case 'design-error': return isNum(m.requestId) && isStr(m.message) ? (m as PluginToUi) : null;
    case 'templates': {
      if (!isObj(m.templates)) return null;
      const templates: Record<string, TemplateConfig> = {};
      for (const [k, v] of Object.entries(m.templates)) if (isTemplate(v) && v.hash === k) templates[k] = v;
      return { type: 'templates', templates };
    }
    default: return null;
  }
}
