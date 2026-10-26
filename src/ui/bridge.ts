// UI side of the plugin message channel.

import { parsePluginMessage, type PluginToUi, type UiToPlugin, type FrameInfo } from '../shared/messages';
import type { DesignSource } from '../core/render/types';

type Listener = (m: PluginToUi) => void;
const FIGMA_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*figma\.com$/;
const listeners = new Set<Listener>();

window.addEventListener('message', (e: MessageEvent) => {
  // Figma relays plugin messages under `pluginMessage`, from the parent window or a figma.com origin
  // (the desktop app may deliver them through its own frame). Payloads are validated either way.
  if (e.source !== window.parent && !FIGMA_ORIGIN.test(e.origin)) return;
  const msg = parsePluginMessage((e.data as { pluginMessage?: unknown } | null)?.pluginMessage);
  if (msg) listeners.forEach((l) => l(msg));
});

declare const __PLUGIN_ID__: string;

/** True when the UI runs from the hosted page (own origin) instead of the bundled null-origin HTML. */
export const isHosted = location.origin !== 'null' && !location.protocol.startsWith('data') && location.protocol !== 'about:';

export function send(msg: UiToPlugin) {
  // From a hosted page Figma requires a pluginId and only figma.com may receive the message.
  if (isHosted) parent.postMessage({ pluginMessage: msg, pluginId: __PLUGIN_ID__ }, 'https://www.figma.com');
  else parent.postMessage({ pluginMessage: msg }, '*');
}
export function listen(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; }

let nextId = 1;
function exportFrame(nodeId: string, scale: number): Promise<{ bytes: Uint8Array; scale: number }> {
  const requestId = nextId++;
  return new Promise((resolve, reject) => {
    const off = listen((m) => {
      if ((m.type === 'design-image' || m.type === 'design-error') && m.requestId === requestId) {
        off();
        if (m.type === 'design-image') resolve({ bytes: m.bytes, scale: m.scale }); else reject(new Error(m.message));
      }
    });
    send({ type: 'export-design', requestId, nodeId, scale });
  });
}

/**
 * Design source backed by Figma exportAsync. Rasters are cached per scale bucket; the UI
 * creates a new source on selection change or refresh, which drops the cache.
 */
export function figmaDesignSource(frame: FrameInfo): DesignSource {
  const cache = new Map<number, Promise<ImageBitmap>>();
  return {
    width: frame.width,
    height: frame.height,
    getImage(scale) {
      // Round up to a coarse bucket so small placement tweaks reuse the raster.
      const bucket = Math.min(64, Math.pow(2, Math.ceil(Math.log2(Math.max(scale, 1 / 64)) * 4) / 4));
      let p = cache.get(bucket);
      if (!p) {
        p = exportFrame(frame.id, bucket).then(({ bytes }) => createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' })));
        p.catch(() => cache.delete(bucket));
        cache.set(bucket, p);
      }
      return p;
    },
  };
}
