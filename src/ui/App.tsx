import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen, send, figmaDesignSource } from './bridge';
import type { FrameInfo, TemplateConfig } from '../shared/messages';
import { DEFAULT_PLACEMENT, centered, type Placement } from '../core/placement';
import { DEFAULT_EXPORT, SCALE_PRESETS, checkOutputSize, type ExportOptions } from '../core/export';
import { hashBytes, sniffMockup } from '../core/validate';
import { applyH, homography, invert3, rectQuad } from '../core/geometry';
import type { MockupInspection, SmartObjectCandidate, Issue } from '../core/psd/inspect';
import type { MockupRenderer } from '../core/render/types';
import { NativeRenderer, type FidelityReport } from '../core/render/native/compositor';
import { PhotopeaRenderer } from '../core/render/photopea/photopea';

type RendererKind = 'native' | 'photopea';
interface Mockup { name: string; bytes: ArrayBuffer; hash: string }

const PREVIEW_MAX = 760;

export function App() {
  const [frame, setFrame] = useState<FrameInfo | null>(null);
  const [frameReason, setFrameReason] = useState('Select a frame to place into a mockup.');
  const [frameVersion, setFrameVersion] = useState(0);
  const [templates, setTemplates] = useState<Record<string, TemplateConfig>>({});
  const [mockup, setMockup] = useState<Mockup | null>(null);
  const [kind, setKind] = useState<RendererKind>('native');
  const [photopeaConsent, setPhotopeaConsent] = useState(false);
  const [inspection, setInspection] = useState<MockupInspection | null>(null);
  const [fidelity, setFidelity] = useState<Omit<FidelityReport, 'diff'> | null>(null);
  const [targetIdx, setTargetIdx] = useState(0);
  const [placement, setPlacement] = useState<Placement>(DEFAULT_PLACEMENT);
  const [exp, setExp] = useState<ExportOptions>(DEFAULT_EXPORT);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [previewScale, setPreviewScale] = useState(0);
  const [connected, setConnected] = useState(false);

  const rendererRef = useRef<MockupRenderer | null>(null);
  const previewHost = useRef<HTMLDivElement>(null);
  const photopeaHost = useRef<HTMLDivElement>(null);
  const renderSeq = useRef(0);

  // --- plugin messages -------------------------------------------------------
  useEffect(() => listen((m) => {
    setConnected(true);
    if (m.type === 'selection') {
      setFrame(m.frame);
      if (!m.frame) setFrameReason(m.reason ?? 'Select a frame.');
      setFrameVersion((v) => v + 1);
    } else if (m.type === 'templates') setTemplates(m.templates);
  }), []);
  useEffect(() => { send({ type: 'load-templates' }); }, []);

  const design = useMemo(() => (frame ? figmaDesignSource(frame) : null), [frame, frameVersion]);
  const previewUrl = useMemo(() => (frame ? URL.createObjectURL(new Blob([frame.preview as BlobPart], { type: 'image/png' })) : null), [frame]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const target: SmartObjectCandidate | undefined = inspection?.candidates[targetIdx];

  // --- open mockup -----------------------------------------------------------
  const openMockup = useCallback(async (m: Mockup, k: RendererKind) => {
    setError(null); setBusy('Reading PSD…'); setInspection(null); setFidelity(null);
    rendererRef.current?.dispose();
    try {
      const r: MockupRenderer = k === 'photopea' ? new PhotopeaRenderer(photopeaHost.current!) : new NativeRenderer();
      rendererRef.current = r;
      const insp = await r.open(m.bytes);
      if (!insp.candidates.length) throw new Error('No Smart Objects found. Add a Smart Object placeholder to this mockup in Photoshop or Photopea.');
      setInspection(insp);
      if (r instanceof NativeRenderer) {
        setBusy('Checking fidelity against Photoshop\'s composite…');
        await new Promise((res) => setTimeout(res, 0));
        const f = r.selfCheck();
        if (f) { const { diff, ...rest } = f; diff.width = 0; setFidelity(rest); }
      }
      const saved = templates[m.hash];
      const idx = saved ? insp.candidates.findIndex((c) => (saved.target.layerId !== undefined && c.ref.layerId === saved.target.layerId) || c.ref.path.join('/') === saved.target.path.join('/')) : -1;
      setTargetIdx(Math.max(0, idx));
      setPlacement(saved && idx >= 0 ? saved.placement : DEFAULT_PLACEMENT);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(null); }
  }, [templates]);

  const onFile = useCallback(async (file: File) => {
    setError(null);
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const check = sniffMockup(head, file.size);
    if (!check.ok) { setError(check.reason ?? 'Unsupported file.'); return; }
    setBusy('Loading file…');
    try {
      const bytes = await file.arrayBuffer();
      const m = { name: file.name, bytes, hash: await hashBytes(bytes) };
      setMockup(m);
      await openMockup(m, kind);
    } catch (e) {
      setError(`Could not read the file: ${(e as Error).message}`);
      setBusy(null);
    }
  }, [kind, openMockup]);

  // --- preview ---------------------------------------------------------------
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !inspection || !target || busy) return;
    const seq = ++renderSeq.current;
    const s = Math.min(1, PREVIEW_MAX / inspection.width);
    if (!design) {
      // No frame yet: show the mockup itself so the user sees it loaded.
      if (r instanceof NativeRenderer && previewHost.current) {
        const c = r.renderOriginal(s);
        c.style.maxWidth = `${Math.round(inspection.width * s)}px`;
        previewHost.current.replaceChildren(c);
        setPreviewScale(s);
      }
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await r.render({ target: target.ref, design, placement, scale: kind === 'photopea' ? 1 : s });
        if (seq !== renderSeq.current || !previewHost.current || !res.canvas) return;
        res.canvas.style.maxWidth = `${Math.round(inspection.width * s)}px`;
        previewHost.current.replaceChildren(res.canvas);
        setPreviewScale(s);
        setWarnings(res.warnings);
        setError(null);
      } catch (e) { if (seq === renderSeq.current) setError((e as Error).message); }
    }, kind === 'photopea' ? 600 : 120);
    return () => clearTimeout(t);
  }, [inspection, target, design, placement, kind, busy]);

  // --- drag in placeholder space ----------------------------------------------
  const drag = useRef<{ x: number; y: number; start: Placement } | null>(null);
  const toSlot = useMemo(() => {
    if (!target) return null;
    const inv = invert3(homography(rectQuad(target.width, target.height), target.quad));
    return (docX: number, docY: number) => applyH(inv, { x: docX, y: docY });
  }, [target]);
  // Pointer position in mockup document pixels, measured on the displayed canvas.
  const docPoint = (e: React.PointerEvent) => {
    const canvas = previewHost.current?.querySelector('canvas');
    if (!canvas || !inspection) return null;
    const rect = canvas.getBoundingClientRect();
    const k = inspection.width / rect.width;
    return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (!previewScale) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = docPoint(e);
    if (p) drag.current = { ...p, start: placement };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !toSlot) return;
    const p = docPoint(e);
    if (!p) return;
    const a = toSlot(d.x, d.y), b = toSlot(p.x, p.y);
    setPlacement({ ...d.start, offsetX: Math.round(d.start.offsetX + b.x - a.x), offsetY: Math.round(d.start.offsetY + b.y - a.y) });
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!target) return;
    setPlacement((p) => ({ ...p, scale: Math.min(10, Math.max(0.05, p.scale * Math.exp(-e.deltaY * 0.0015))) }));
  };

  // --- template + export ------------------------------------------------------
  const saveTemplate = useCallback(() => {
    if (!mockup || !target) return;
    send({ type: 'save-template', template: { hash: mockup.hash, fileName: mockup.name, renderer: kind, target: { ...target.ref, name: target.name, width: target.width, height: target.height }, placement, updatedAt: Date.now() } });
    send({ type: 'notify', message: 'Template saved' });
  }, [mockup, target, placement, kind]);

  const size = inspection ? checkOutputSize(inspection.width, inspection.height, exp.scale) : null;

  const doExport = useCallback(async () => {
    const r = rendererRef.current;
    if (!r || !target || !design || !mockup || !size?.ok) return;
    setBusy(`Rendering ${size.width}×${size.height}…`); setError(null);
    try {
      const res = await r.render({ target: target.ref, design, placement, scale: exp.scale, encode: exp });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(res.blob!);
      a.download = `${mockup.name.replace(/\.(psd|psb)$/i, '')}-${frame?.name ?? 'design'}@${exp.scale}x.${exp.format === 'png' ? 'png' : 'jpg'}`.replace(/[\\/:*?"<>|]+/g, '-');
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      res.canvas && (res.canvas.width = 0);
      saveTemplate();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }, [target, design, mockup, size, placement, exp, frame, saveTemplate]);

  const switchRenderer = (k: RendererKind) => {
    setKind(k);
    if (mockup && (k === 'native' || photopeaConsent)) openMockup(mockup, k);
  };

  const issues: Issue[] = [...(inspection?.issues ?? []), ...(target?.issues ?? [])];
  const P = (patch: Partial<Placement>) => setPlacement((p) => ({ ...p, ...patch }));

  return (
    <div className="app">
      <aside className="side">
        <section>
          <h2>Frame <button className="link" onClick={() => send({ type: 'refresh' })} title="Re-export after editing the frame">Refresh</button></h2>
          {frame ? (
            <div className="frame">
              {previewUrl && <img src={previewUrl} alt="" />}
              <div><strong>{frame.name}</strong><br /><span className="muted">{Math.round(frame.width)} × {Math.round(frame.height)}</span></div>
            </div>
          ) : <p className="muted">{connected ? frameReason : 'Waiting for Figma… If this stays, close and reopen the plugin.'}</p>}
        </section>

        <section>
          <h2>Mockup</h2>
          <label className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}>
            <input type="file" accept=".psd,.psb" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
            {mockup ? <span><strong>{mockup.name}</strong><br /><span className="muted">{(mockup.bytes.byteLength / 1e6).toFixed(1)} MB{templates[mockup.hash] ? ' · saved template' : ''}</span></span> : <span>Drop a PSD or click to choose</span>}
          </label>
          <div className="row">
            <label><input type="radio" checked={kind === 'native'} onChange={() => switchRenderer('native')} /> Built-in renderer</label>
            <label><input type="radio" checked={kind === 'photopea'} onChange={() => switchRenderer('photopea')} /> Photopea</label>
          </div>
          {kind === 'photopea' && !photopeaConsent && (
            <div className="notice">
              Photopea is a third-party web app. Your PSD and frame image are opened inside photopea.com in this window. Only use mockups you are allowed to process there.
              <button onClick={() => { setPhotopeaConsent(true); if (mockup) openMockup(mockup, 'photopea'); }}>I understand, use Photopea</button>
            </div>
          )}
          {inspection && (
            <>
              <p className="muted">{inspection.width} × {inspection.height} px · {inspection.colorMode} {inspection.bitsPerChannel}-bit · {inspection.layerCount} layers</p>
              {fidelity && <p className={fidelity.pctPixelsOver8 < 1 ? 'ok' : 'warn'}>Reproduces Photoshop's composite: {(100 - fidelity.pctPixelsOver8).toFixed(1)}% of pixels within 8 levels.</p>}
              <h3>Placeholder</h3>
              {inspection.candidates.map((c, i) => (
                <label key={i} className="cand">
                  <input type="radio" checked={i === targetIdx} onChange={() => { setTargetIdx(i); setPlacement(DEFAULT_PLACEMENT); }} />
                  <span>{c.ref.path.join(' / ')}<br /><span className="muted">{c.width} × {c.height}{c.perspective ? ' · perspective' : ''}{c.hidden ? ' · hidden' : ''}{c.linked ? ' · linked' : ''}</span></span>
                </label>
              ))}
              <button onClick={saveTemplate} disabled={!target}>Save as template</button>
            </>
          )}
          {issues.length > 0 && <details open={issues.some((i) => i.severity !== 'info')}><summary>{issues.length} compatibility notes</summary><ul className="issues">{issues.map((i, n) => <li key={n} className={i.severity}>{i.layer ? <em>{i.layer}: </em> : null}{i.message}</li>)}</ul></details>}
        </section>
      </aside>

      <main className="stage">
        <div className="preview" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => (drag.current = null)} onWheel={onWheel}>
          <div ref={previewHost} />
          {!inspection && <p className="muted center">{frame ? 'Choose a PSD mockup.' : 'Select a frame, then choose a PSD mockup.'}</p>}
          {inspection && !frame && <p className="muted center">Select a frame in Figma to place it into this mockup.</p>}
        </div>
        <div ref={photopeaHost} className={kind === 'photopea' && photopeaConsent ? 'photopea' : 'photopea hidden'} />
        {busy && <div className="busy">{busy}</div>}
        {error && <div className="error">{error}</div>}
        {warnings.length > 0 && <details className="warnings"><summary>{warnings.length} rendering notes</summary><ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
      </main>

      <aside className="side">
        <section>
          <h2>Placement</h2>
          <div className="seg">{(['fit', 'fill', 'stretch'] as const).map((m) => <button key={m} className={placement.mode === m ? 'on' : ''} onClick={() => P({ mode: m })}>{m}</button>)}</div>
          <label className="check"><input type="checkbox" checked={placement.lockAspect} onChange={(e) => P({ lockAspect: e.target.checked })} /> Lock aspect ratio</label>
          <label>Scale {Math.round(placement.scale * 100)}%<input type="range" min={0.05} max={3} step={0.01} value={placement.scale} onChange={(e) => P({ scale: +e.target.value })} /></label>
          <label>Rotation {placement.rotation}°<input type="range" min={-180} max={180} step={1} value={placement.rotation} onChange={(e) => P({ rotation: +e.target.value })} /></label>
          <div className="row">
            <label>X <input type="number" value={placement.offsetX} onChange={(e) => P({ offsetX: +e.target.value })} /></label>
            <label>Y <input type="number" value={placement.offsetY} onChange={(e) => P({ offsetY: +e.target.value })} /></label>
          </div>
          <div className="row">
            <button onClick={() => setPlacement(centered)}>Center</button>
            <button onClick={() => setPlacement(templates[mockup?.hash ?? '']?.placement ?? DEFAULT_PLACEMENT)}>Reset</button>
          </div>
          <p className="muted small">Drag the preview to move, scroll to zoom. Offsets are in placeholder pixels.</p>
        </section>

        <section>
          <h2>Export</h2>
          <div className="seg">{(['png', 'jpeg'] as const).map((f) => <button key={f} className={exp.format === f ? 'on' : ''} onClick={() => setExp({ ...exp, format: f })}>{f === 'png' ? 'PNG' : 'JPG'}</button>)}</div>
          <div className="seg">{SCALE_PRESETS.map((s) => <button key={s} className={exp.scale === s ? 'on' : ''} onClick={() => setExp({ ...exp, scale: s })}>{s}×</button>)}</div>
          {size && <p className={size.ok ? 'muted' : 'error'}>{size.ok ? `${size.width} × ${size.height} px` : size.reason}</p>}
          {exp.format === 'jpeg' && (
            <>
              <label>Quality {Math.round(exp.jpegQuality * 100)}<input type="range" min={0.3} max={1} step={0.01} value={exp.jpegQuality} onChange={(e) => setExp({ ...exp, jpegQuality: +e.target.value })} /></label>
              <label className="check">Background <input type="color" value={exp.jpegBackground} onChange={(e) => setExp({ ...exp, jpegBackground: e.target.value })} /></label>
            </>
          )}
          {exp.format === 'png' && <p className="muted small">Transparent areas stay transparent.</p>}
          <button className="primary" disabled={!target || !design || !!busy || !size?.ok} onClick={doExport}>Export</button>
        </section>
      </aside>
    </div>
  );
}
