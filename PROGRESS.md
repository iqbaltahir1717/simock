# Progress

Last updated: 2026-10-26 (after real PSD test). Read this first in a new session.

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
- [x] Real PSD sample from the user (MacBook Pro mockup, 3000×2000, 39 MB): see results below. Not committed (user's licensed file); kept in project files root.
- [x] Native renderer additions driven by the sample: Levels adjustment layers, Color Fill (solidFill) effect, shared Smart Object instances updated together, Gaussian Blur smart filter re-applied on instances, identity-warp detection, one placeholder entry per Smart Object contents.
- [x] Plugin runs in Figma desktop (user, 2026-10-26): PSD loads, self-check shows 100% within 8 levels, frame selection + preview work after accepting figma.com message origin (strict `source === parent` check dropped Figma's messages).
- [ ] In Figma: confirm export download, Refresh, template save/restore (asked user).
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

### Real PSD: "Macbook Pro Mockup 2.psd" (Photoshop file, RGB 8-bit, 3000×2000)
- Structure: placeholder "Your Design" (SO 3072×1920, perspective, Color Fill screen 10%); "Reflection" = same SO contents, flipped, Gaussian Blur 9px, screen 10%, masked; Levels adjustment (masked) in a pass-through group; laptop and background raster layers.
- Self-check, untouched document vs Photoshop's stored composite: MAE 0.21/255, 0% of pixels differ by >8 (before adding Levels + Color Fill it was MAE 13.7, 74% >8).
- End-to-end replacement check: replace the SO with its own original contents through our pipeline (frame → placeholder space → perspective → effects → stack) and compare to Photoshop: MAE 0.25/255, 0.16% of pixels >8, 0.05% >32 (antialiased edges). The embedded PSB's own stored composite is blank, so its layers were rendered with our compositor first.
- Blur calibration could not be measured on this file (reflection contribution below measurement); sigma = radius for now.
- Export timings (headless Chromium, CPU WebGL): 0.5× 0.6 s, 1× ~1 s, 2× (6000×4000) 6.3 s, 4× (12000×8000) 17 s. Expect faster with a GPU.

## Decisions and facts to remember

- 1× = PSD native size. Above 1× the mockup photo is upscaled, the design is rendered sharp.
- Photopea free tier shows ads → not allowed in a published Figma plugin; needs Distributor or self-hosting for release.
- Billing interval is undecided; do not assume monthly or lifetime.
