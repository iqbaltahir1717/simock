// Renderer contract. The UI talks only to this interface so the native renderer,
// Photopea, or a future server renderer can be swapped without touching the UI.

import type { Placement } from '../placement';
import type { ExportOptions } from '../export';
import type { LayerRef, MockupInspection } from '../psd/inspect';

export interface DesignSource {
  /** Frame size in Figma at 1x. */
  width: number;
  height: number;
  /** Rasterise the frame at `scale` (Figma exportAsync in the plugin; a fixture in tests). */
  getImage(scale: number): Promise<ImageBitmap | HTMLCanvasElement | HTMLImageElement>;
}

export interface RenderRequest {
  target: LayerRef;
  design: DesignSource;
  placement: Placement;
  /** Output scale relative to the document's native size. Previews use small values. */
  scale: number;
  /** Encode to a file. Omit for an on-screen preview canvas. */
  encode?: ExportOptions;
  signal?: AbortSignal;
}

export interface RenderResult {
  canvas?: HTMLCanvasElement;
  blob?: Blob;
  width: number;
  height: number;
  /** Things that were skipped or approximated in this render. */
  warnings: string[];
  ms: number;
}

export interface MockupRenderer {
  readonly id: 'native' | 'photopea';
  readonly label: string;
  /** Whether the renderer sends file data outside the plugin (must be disclosed to the user). */
  readonly thirdParty: boolean;
  open(file: ArrayBuffer): Promise<MockupInspection>;
  render(req: RenderRequest): Promise<RenderResult>;
  dispose(): void;
}
