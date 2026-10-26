// Validation of untrusted mockup files before they reach any parser.
// We only ever parse bytes; nothing embedded in a file is executed.

import { sha256Hex } from './sha256';

export type MockupKind = 'psd' | 'psb' | 'eps' | 'unknown';

export const MAX_MOCKUP_BYTES = 1024 * 1024 * 1024; // 1 GB personal-tool ceiling

export interface FileCheck { ok: boolean; kind: MockupKind; reason?: string; width?: number; height?: number }

function u32(b: Uint8Array, o: number) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

export function sniffMockup(bytes: Uint8Array, byteLength = bytes.length): FileCheck {
  if (byteLength === 0) return { ok: false, kind: 'unknown', reason: 'The file is empty.' };
  if (byteLength > MAX_MOCKUP_BYTES) return { ok: false, kind: 'unknown', reason: 'The file is larger than 1 GB.' };
  if (bytes.length < 26) return { ok: false, kind: 'unknown', reason: 'The file is too small to be a PSD.' };

  const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (sig === '8BPS') {
    const version = (bytes[4] << 8) | bytes[5];
    const height = u32(bytes, 14), width = u32(bytes, 18);
    const depth = (bytes[22] << 8) | bytes[23];
    const kind: MockupKind = version === 2 ? 'psb' : version === 1 ? 'psd' : 'unknown';
    if (kind === 'unknown') return { ok: false, kind, reason: `Unsupported Photoshop file version ${version}.` };
    const maxDim = kind === 'psd' ? 30000 : 300000;
    if (!width || !height || width > maxDim || height > maxDim) return { ok: false, kind, reason: `Invalid document size ${width}×${height}.` };
    if (![1, 8, 16, 32].includes(depth)) return { ok: false, kind, reason: `Unsupported bit depth ${depth}.` };
    return { ok: true, kind, width, height };
  }
  // DOS EPS binary header C5 D0 D3 C6, or plain PostScript header.
  const isDosEps = bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6;
  const head = String.fromCharCode(...bytes.subarray(0, 11));
  if (isDosEps || head.startsWith('%!PS-Adobe')) {
    return { ok: false, kind: 'eps', reason: 'EPS files have no Smart Objects. Convert the mockup to PSD with a Smart Object placeholder (see the EPS workflow notes).' };
  }
  return { ok: false, kind: 'unknown', reason: 'Not a Photoshop document (missing 8BPS signature).' };
}

/** SHA-256 of the file, used as a stable key for saved template configuration. */
export async function hashBytes(buf: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return sha256Hex(new Uint8Array(buf));
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
