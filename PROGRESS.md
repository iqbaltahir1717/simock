# Progress

Last updated: 2026-10-26. Read this first in a new session.

## Where the code lives

- No GitHub repo yet (none of the user's repos fit). Local git repo; a copy (without node_modules) is kept in the project files at `/mnt/project-files/simock/`.
- To continue in a fresh container: copy that folder, `npm install`, then `npm test && npm run harness && npm run ui-smoke`.
- Playwright: the cloud container has a global Playwright + Chromium (scripts load it with `createRequire`). Locally: `npm i -D playwright`.

## Phase checklist

### Phase 1: feasibility and one real PSD proof
- [x] Verify current APIs: Figma networkAccess/null-origin iframe, clientStorage 5 MB, OAuth relay flow; Photopea API/live messaging/accounts; Drive scopes; Figma review rules (no ads).
- [x] Core: geometry, placement (placeholder space), export presets + limits, file sniffing, SHA-256 template key (with JS fallback).
- [x] PSD inspection: Smart Object candidates (id/path/index, size, quad, perspective, warp, linked, nested, smart filters, effects) + document issues.
- [x] Native renderer: layer stack compositor + WebGL perspective warp, tiled; PNG/JPG encode; memory/canvas guard; fidelity self-check vs stored composite.
- [x] Photopea renderer: iframe bridge + replace-contents script + consent gate. **Not run yet** (photopea.com blocked in the cloud container).
- [x] Figma main thread: selection (1 frame), live selectionchange, refresh, exportAsync at requested scale, template storage.
- [x] React UI: frame panel, PSD upload, placeholder picker, compatibility notes, placement (drag/zoom/rotate/fit/fill/center/reset), export (format, 0.5–4×, size preview, JPG quality, JPG background).
- [x] Tests: 12 unit tests, 24 synthetic Chromium checks, 11 UI smoke checks — all passing.
- [ ] **Real PSD sample from the user** → `node harness/run.mjs sample.psd`, check self-check score and outputs.
- [ ] Run the plugin inside Figma desktop (selection, exportAsync, download from plugin UI, clientStorage).
- [ ] Run `npm run harness:photopea` where photopea.com is reachable; also test Photopea nested inside the Figma plugin iframe.

### Phase 2: personal MVP
- [ ] Persisted local library (thumbnails + metadata in clientStorage; PSD bytes re-picked or cached where possible).
- [ ] Template setup flow polish (multiple placeholders, per-template defaults), parse in a Worker.
- [ ] Preview: low-res mockup cache, faster drag (warp-only redraw).
- [ ] Flat-template mode for EPS-derived rasters (explicitly labelled).

### Phase 3: Google Drive library
- [ ] OAuth relay endpoint (serverless, PKCE, read/write keys, no token retention), `drive.file` scope, hosted Picker page.
- [ ] LibraryStore interface: list with pagination + thumbnails, on-demand PSD download, upload with progress.

### Phase 4: performance and compatibility
- [ ] Tiled full-pipeline rendering for 4× on large mockups; Worker/OffscreenCanvas.
- [ ] Layer effects (drop shadow, inner shadow, color overlay) and common adjustment layers in the native renderer, driven by self-check failures on real mockups.

### Phase 5: commercial
- [ ] Accounts, entitlements, billing (Figma native payments vs external; interval undecided), quotas, onboarding, privacy policy, Photopea Distributor decision.

## Test results (2026-10-26, cloud container, Chromium 153 headless + SwiftShader)

- Synthetic PSD (generated with ag-psd: perspective Smart Object, multiply shadow, clipped screen glare, masked layer, transparent border): 24/24 checks. Geometry, blend math, clipping, masks, PNG alpha, JPG background/quality, all scale presets (4× = 4800×3200 in ~3.3 s), placement offset/scale/rotation, oversize refusal, EPS detection.
- UI smoke in sandboxed null-origin iframe with mock Figma host: 11/11 (selection, upload, self-check, preview, drag, sizes, JPG download, template save/restore, refresh).
- Found and fixed: `crypto.subtle` missing in the sandboxed iframe → JS SHA-256 fallback; `</script>` in inlined UI.
- Synthetic PSDs are not proof of Photoshop compatibility: their stored composite was produced by our own compositor.

## Decisions and facts to remember

- 1× = PSD native size. Above 1× the mockup photo is upscaled, the design is rendered sharp.
- Photopea free tier shows ads → not allowed in a published Figma plugin; needs Distributor or self-hosting for release.
- Billing interval is undecided; do not assume monthly or lifetime.
