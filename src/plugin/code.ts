/// <reference types="@figma/plugin-typings" />
// Figma main thread. Owns every document operation: reading the selection and
// rasterising the selected frame. It never modifies the document.

import { parseUiMessage, isTemplate, type PluginToUi, type TemplateConfig } from '../shared/messages';

const SUPPORTED = new Set<NodeType>(['FRAME', 'COMPONENT', 'INSTANCE']);
const TEMPLATES_KEY = 'templates.v1';
/** Our own cap on design rasters; larger requests are scaled down and reported. */
const MAX_EXPORT_SIDE = 16384;

figma.showUI(__html__, { width: 960, height: 680, themeColors: true, title: 'Simock' });

const post = (msg: PluginToUi) => figma.ui.postMessage(msg);

let selectionToken = 0;
async function sendSelection() {
  const token = ++selectionToken;
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) {
    post({ type: 'selection', frame: null, reason: sel.length === 0 ? 'Select a frame to place into a mockup.' : 'Select a single frame.' });
    return;
  }
  // A layer inside a frame counts as its outermost frame on the page.
  let node: BaseNode | null = sel[0];
  let frameNode: SceneNode | null = null;
  for (; node && node.type !== 'PAGE'; node = node.parent) if (SUPPORTED.has(node.type)) frameNode = node as SceneNode;
  if (!frameNode) {
    post({ type: 'selection', frame: null, reason: `${sel[0].type.toLowerCase()} selected. Select a frame, component or instance.` });
    return;
  }
  const n = frameNode as FrameNode | ComponentNode | InstanceNode;
  try {
    const longest = Math.max(n.width, n.height);
    const preview = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: Math.min(2, 480 / longest) } });
    if (token !== selectionToken) return; // a newer selection arrived meanwhile
    post({ type: 'selection', frame: { id: n.id, name: n.name, width: n.width, height: n.height, preview } });
  } catch (e) {
    if (token === selectionToken) post({ type: 'selection', frame: null, reason: `Could not preview the frame: ${(e as Error).message}` });
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
figma.on('selectionchange', () => { clearTimeout(debounce); debounce = setTimeout(sendSelection, 120); });

async function readTemplates(): Promise<Record<string, TemplateConfig>> {
  const raw = await figma.clientStorage.getAsync(TEMPLATES_KEY);
  const out: Record<string, TemplateConfig> = {};
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (isTemplate(v) && v.hash === k) out[k] = v;
  return out;
}

figma.ui.onmessage = async (raw: unknown) => {
  const msg = parseUiMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'refresh':
      await sendSelection();
      break;
    case 'export-design': {
      try {
        const node = await figma.getNodeByIdAsync(msg.nodeId);
        if (!node || !SUPPORTED.has(node.type)) throw new Error('The frame no longer exists.');
        const n = node as FrameNode;
        let scale = Math.max(0.01, msg.scale);
        if (Math.max(n.width, n.height) * scale > MAX_EXPORT_SIDE) scale = MAX_EXPORT_SIDE / Math.max(n.width, n.height);
        const bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
        post({ type: 'design-image', requestId: msg.requestId, bytes, scale });
      } catch (e) {
        post({ type: 'design-error', requestId: msg.requestId, message: (e as Error).message });
      }
      break;
    }
    case 'load-templates':
      post({ type: 'templates', templates: await readTemplates() });
      break;
    case 'save-template': {
      const all = await readTemplates();
      all[msg.template.hash] = msg.template;
      await figma.clientStorage.setAsync(TEMPLATES_KEY, all);
      post({ type: 'templates', templates: all });
      break;
    }
    case 'notify':
      figma.notify(msg.message, { error: msg.error });
      break;
  }
};

sendSelection();
