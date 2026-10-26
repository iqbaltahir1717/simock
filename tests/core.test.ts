import { describe, expect, it } from 'vitest';
import { applyH, homography, invert3, isAffineQuad, rectQuad, type Quad, applyAffine } from '../src/core/geometry';
import { DEFAULT_PLACEMENT, placementMatrix, designExportScale } from '../src/core/placement';
import { checkOutputSize, outputSize, SCALE_PRESETS } from '../src/core/export';
import { sniffMockup } from '../src/core/validate';
import { parseUiMessage, isTemplate } from '../src/shared/messages';

const quad: Quad = [{ x: 300, y: 150 }, { x: 900, y: 120 }, { x: 940, y: 600 }, { x: 260, y: 640 }];

describe('geometry', () => {
  it('maps rect corners onto the quad and back', () => {
    const H = homography(rectQuad(600, 400), quad);
    rectQuad(600, 400).forEach((p, i) => {
      const q = applyH(H, p);
      expect(q.x).toBeCloseTo(quad[i].x, 6); expect(q.y).toBeCloseTo(quad[i].y, 6);
    });
    const back = applyH(invert3(H), quad[2]);
    expect(back.x).toBeCloseTo(600, 6); expect(back.y).toBeCloseTo(400, 6);
  });
  it('detects affine vs perspective quads', () => {
    expect(isAffineQuad(quad)).toBe(false);
    expect(isAffineQuad([{ x: 0, y: 0 }, { x: 10, y: 2 }, { x: 12, y: 12 }, { x: 2, y: 10 }])).toBe(true);
  });
});

describe('placement', () => {
  const design = { width: 1000, height: 500 }, slot = { width: 600, height: 400 };
  it('fill covers the slot, fit stays inside', () => {
    const fill = placementMatrix(design, slot, { ...DEFAULT_PLACEMENT, mode: 'fill' });
    expect(fill[0]).toBeCloseTo(0.8); // 400/500
    const fit = placementMatrix(design, slot, { ...DEFAULT_PLACEMENT, mode: 'fit' });
    expect(fit[0]).toBeCloseTo(0.6); // 600/1000
    const c = applyAffine(fit, { x: 500, y: 250 });
    expect(c.x).toBeCloseTo(300); expect(c.y).toBeCloseTo(200);
  });
  it('stretch without aspect lock fills each axis', () => {
    const m = placementMatrix(design, slot, { ...DEFAULT_PLACEMENT, mode: 'stretch', lockAspect: false });
    expect(m[0]).toBeCloseTo(0.6); expect(m[3]).toBeCloseTo(0.8);
  });
  it('offset and rotation are applied in slot space around the design centre', () => {
    const m = placementMatrix(design, slot, { ...DEFAULT_PLACEMENT, mode: 'fit', rotation: 90, offsetX: 10, offsetY: -5 });
    const c = applyAffine(m, { x: 500, y: 250 });
    expect(c.x).toBeCloseTo(310); expect(c.y).toBeCloseTo(195);
    const tl = applyAffine(m, { x: 0, y: 0 }); // rotated 90° clockwise: top-left goes to top-right
    expect(tl.x).toBeCloseTo(310 + 150); expect(tl.y).toBeCloseTo(195 - 300);
  });
  it('requests a raster matching the output resolution', () => {
    expect(designExportScale(design, slot, DEFAULT_PLACEMENT, 2)).toBeCloseTo(1.6);
  });
});

describe('export sizing', () => {
  it('1x is the document size and presets scale it', () => {
    expect(SCALE_PRESETS).toEqual([0.5, 0.75, 1, 2, 4]);
    expect(outputSize(3000, 2000, 1)).toEqual({ width: 3000, height: 2000 });
    expect(outputSize(3000, 2000, 0.75)).toEqual({ width: 2250, height: 1500 });
  });
  it('refuses sizes beyond canvas or memory limits', () => {
    expect(checkOutputSize(5000, 4000, 4).ok).toBe(false); // 320 MP
    expect(checkOutputSize(9000, 2000, 4).reason).toMatch(/side limit/);
    expect(checkOutputSize(4000, 3000, 4).reason).toMatch(/GB/); // 192 MP fits the area limit but not the memory budget
    expect(checkOutputSize(3000, 2000, 2).ok).toBe(true);
  });
});

describe('file validation', () => {
  const header = (sig: string, version: number, w: number, h: number, depth = 8) => {
    const b = new Uint8Array(32);
    for (let i = 0; i < 4; i++) b[i] = sig.charCodeAt(i);
    b[5] = version;
    new DataView(b.buffer).setUint32(14, h); new DataView(b.buffer).setUint32(18, w); b[23] = depth;
    return b;
  };
  it('accepts PSD and PSB headers', () => {
    expect(sniffMockup(header('8BPS', 1, 4000, 3000))).toMatchObject({ ok: true, kind: 'psd', width: 4000 });
    expect(sniffMockup(header('8BPS', 2, 40000, 3000))).toMatchObject({ ok: true, kind: 'psb' });
  });
  it('rejects junk, bad sizes and EPS with a reason', () => {
    expect(sniffMockup(header('PK\u0003\u0004', 1, 1, 1)).ok).toBe(false);
    expect(sniffMockup(header('8BPS', 1, 40000, 10)).ok).toBe(false);
    const eps = sniffMockup(new Uint8Array([0xc5, 0xd0, 0xd3, 0xc6, ...new Array(40).fill(0)]));
    expect(eps).toMatchObject({ ok: false, kind: 'eps' });
  });
});

describe('message validation', () => {
  const template = { hash: 'a'.repeat(64), fileName: 'x.psd', renderer: 'native', target: { layerId: 3, path: ['Screen'], indexPath: [2], name: 'Screen', width: 10, height: 10 }, placement: DEFAULT_PLACEMENT, updatedAt: 1 };
  it('accepts well-formed messages and rejects others', () => {
    expect(parseUiMessage({ type: 'export-design', requestId: 1, nodeId: '1:2', scale: 2 })).not.toBeNull();
    expect(parseUiMessage({ type: 'export-design', requestId: 1, nodeId: '1:2', scale: -1 })).toBeNull();
    expect(parseUiMessage({ type: 'eval', code: 'x' })).toBeNull();
    expect(isTemplate(template)).toBe(true);
    expect(isTemplate({ ...template, hash: 'nothex' })).toBe(false);
    expect(isTemplate({ ...template, placement: { ...DEFAULT_PLACEMENT, scale: Infinity } })).toBe(false);
  });
});

describe('sha256 fallback', () => {
  it('matches Node crypto', async () => {
    const { createHash } = await import('node:crypto');
    const { sha256Hex } = await import('../src/core/sha256');
    for (const n of [0, 3, 55, 56, 63, 64, 65, 1000, 100_003]) {
      const b = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
      expect(sha256Hex(b)).toBe(createHash('sha256').update(b).digest('hex'));
    }
  });
});
