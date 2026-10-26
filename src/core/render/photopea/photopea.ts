// Photopea renderer: embeds https://www.photopea.com in an iframe and drives it with
// its Live Messaging API (postMessage of ArrayBuffers and scripts, "done" acks,
// saveToOE for results). Photopea is a full PSD engine, so Smart Object perspective,
// warps, smart filters, effects and adjustment layers are rendered by it, not us.
//
// Third-party processing: the PSD and the design are handed to Photopea's web app.
// The UI must get explicit consent before using this renderer. Free Photopea shows
// ads, which Figma does not allow in published plugin UIs; a commercial release
// needs a Photopea Distributor (whitelabel) or self-hosted licence.

import { checkOutputSize } from '../../export';
import { baseScale } from '../../placement';
import { findLayer, inspectPsd, loadPsd, type LayerRef, type MockupInspection } from '../../psd/inspect';
import type { MockupRenderer, RenderRequest, RenderResult } from '../types';
import { createSurface, encodeCanvas } from '../native/compositor';
import type { Psd } from 'ag-psd';

export const PHOTOPEA_ORIGIN = 'https://www.photopea.com';

interface Reply { buffers: ArrayBuffer[]; echoes: string[] }

export class PhotopeaBridge {
  private frame: HTMLIFrameElement;
  private ready: Promise<void>;
  private pending: { resolve: (r: Reply) => void; reject: (e: Error) => void; reply: Reply; timer: number } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private onMessage = (e: MessageEvent) => {
    // Only accept messages from the Photopea frame we created.
    if (e.source !== this.frame.contentWindow || e.origin !== PHOTOPEA_ORIGIN) return;
    const p = this.pending;
    if (e.data === 'done') {
      if (p) { clearTimeout(p.timer); this.pending = null; p.resolve(p.reply); }
      else this.readyResolve?.();
    } else if (e.data instanceof ArrayBuffer) p?.reply.buffers.push(e.data);
    else if (typeof e.data === 'string') p?.reply.echoes.push(e.data);
  };
  private readyResolve?: () => void;

  constructor(container: HTMLElement, private timeoutMs = 180_000) {
    this.frame = document.createElement('iframe');
    this.frame.title = 'Photopea renderer';
    this.frame.style.cssText = 'width:100%;height:100%;border:0';
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = () => { this.readyResolve = undefined; resolve(); };
      setTimeout(() => reject(new Error('Photopea did not load. Check the network connection or plugin network access.')), 60_000);
    });
    window.addEventListener('message', this.onMessage);
    this.frame.src = `${PHOTOPEA_ORIGIN}#${encodeURIComponent(JSON.stringify({}))}`;
    container.appendChild(this.frame);
  }

  /** Sends a script or file and resolves at Photopea's next "done". Calls are serialised. */
  send(msg: string | ArrayBuffer): Promise<Reply> {
    const run = async () => {
      await this.ready;
      return new Promise<Reply>((resolve, reject) => {
        const timer = window.setTimeout(() => { this.pending = null; reject(new Error('Photopea timed out.')); }, this.timeoutMs);
        this.pending = { resolve, reject, reply: { buffers: [], echoes: [] }, timer };
        this.frame.contentWindow!.postMessage(msg, PHOTOPEA_ORIGIN);
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  dispose() { window.removeEventListener('message', this.onMessage); this.frame.remove(); }
}

export interface ReplaceScriptParams {
  ref: LayerRef;
  /** Size the design should have inside the Smart Object, before rotation, in SO pixels. */
  targetW: number; targetH: number;
  /** Design centre offset from SO centre, in SO pixels (from our inspection). */
  offsetX: number; offsetY: number;
  rotation: number;
  /** Our SO size, to rescale if Photopea reports a different SO document size. */
  slotW: number; slotH: number;
  outW: number; outH: number; scale: number;
}

/** Builds the Photopea script. All user-controlled strings go through JSON.stringify. */
export function buildReplaceScript(p: ReplaceScriptParams): string {
  const J = JSON.stringify;
  return `(function(){
var NAMES=${J(p.ref.path)}, IDX=${J(p.ref.indexPath)};
var mock=app.documents[0], design=app.documents[app.documents.length-1];
function pick(c,d){var ls=c.layers,l=ls[ls.length-1-IDX[d]];
 if(!l||l.name!==NAMES[d]){l=null;for(var j=0;j<ls.length;j++){if(ls[j].name===NAMES[d]){l=ls[j];break;}}}
 if(!l)return null;return d===NAMES.length-1?l:pick(l,d+1);}
app.activeDocument=design;design.selection.selectAll();design.selection.copy();
app.activeDocument=mock;var t=pick(mock,0);
if(!t){app.echoToOE("ERR:placeholder layer not found");return;}
mock.activeLayer=t;
executeAction(stringIDToTypeID("placedLayerEditContents"));
var so=app.activeDocument;if(so===mock){app.echoToOE("ERR:layer is not an editable Smart Object");return;}
var fx=so.width/${p.slotW},fy=so.height/${p.slotH};
for(var i=0;i<so.layers.length;i++)so.layers[i].visible=false;
so.paste();var L=so.activeLayer;var b=L.bounds;
L.resize(100*${p.targetW}*fx/(b[2]-b[0]),100*${p.targetH}*fy/(b[3]-b[1]),AnchorPosition.MIDDLECENTER);
${p.rotation ? `L.rotate(${Number(p.rotation)},AnchorPosition.MIDDLECENTER);` : ''}
b=L.bounds;L.translate(so.width/2+${p.offsetX}*fx-(b[0]+b[2])/2,so.height/2+${p.offsetY}*fy-(b[1]+b[3])/2);
so.save();so.close();app.activeDocument=mock;
${p.scale !== 1 ? `mock.resizeImage(${p.outW},${p.outH});` : ''}
mock.saveToOE("png");
app.echoToOE("OK");
})();`;
}

export class PhotopeaRenderer implements MockupRenderer {
  readonly id = 'photopea' as const;
  readonly label = 'Photopea (third-party web app)';
  readonly thirdParty = true;
  private file?: ArrayBuffer;
  private psd?: Psd;
  private bridge: PhotopeaBridge;

  constructor(container: HTMLElement) { this.bridge = new PhotopeaBridge(container); }

  async open(file: ArrayBuffer): Promise<MockupInspection> {
    this.file = file.slice(0);
    this.psd = loadPsd(file, false);
    return inspectPsd(this.psd);
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    const t0 = performance.now();
    if (!this.file || !this.psd) throw new Error('Open a mockup first.');
    const size = checkOutputSize(this.psd.width, this.psd.height, req.scale);
    if (!size.ok) throw new Error(size.reason);
    const layer = findLayer(this.psd, req.target);
    const pl = layer?.placedLayer;
    if (!pl?.width || !pl.height) throw new Error('The saved placeholder layer was not found in this PSD.');
    const slot = { width: pl.width, height: pl.height };
    const { sx, sy } = baseScale(req.design, slot, req.placement.mode, req.placement.lockAspect);
    const tw = req.design.width * sx * req.placement.scale, th = req.design.height * sy * req.placement.scale;

    // Design raster at Smart Object resolution; Photopea re-renders the SO when resizing.
    const img = await req.design.getImage(Math.max(sx, sy) * req.placement.scale);
    const c = createSurface(img.width, img.height);
    c.drawImage(img, 0, 0);
    const designPng = await (await encodeCanvas(c.canvas, 'png', 1, '#0000')).arrayBuffer();

    // Fresh documents each render: close everything, then open mockup then design.
    await this.bridge.send('while(app.documents.length)app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);');
    await this.bridge.send(this.file.slice(0));
    await this.bridge.send(designPng);
    const reply = await this.bridge.send(buildReplaceScript({
      ref: req.target, targetW: tw, targetH: th, offsetX: req.placement.offsetX, offsetY: req.placement.offsetY,
      rotation: req.placement.rotation, slotW: slot.width, slotH: slot.height, outW: size.width, outH: size.height, scale: req.scale,
    }));
    const err = reply.echoes.find((e) => e.startsWith('ERR:'));
    if (err) throw new Error(`Photopea: ${err.slice(4)}`);
    const png = reply.buffers[0];
    if (!png) throw new Error('Photopea returned no image.');

    const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
    const out = createSurface(bmp.width, bmp.height);
    out.drawImage(bmp, 0, 0);
    let blob: Blob | undefined;
    if (req.encode) blob = req.encode.format === 'png' ? new Blob([png], { type: 'image/png' }) : await encodeCanvas(out.canvas, 'jpeg', req.encode.jpegQuality, req.encode.jpegBackground);
    return { canvas: out.canvas, blob, width: bmp.width, height: bmp.height, warnings: [], ms: performance.now() - t0 };
  }

  dispose() { this.bridge.dispose(); }
}
