# Simock architecture (Phase 1)

Figma plugin that places a selected frame into the user's own PSD mockups by replacing a Smart Object, then exports PNG/JPG.

## Recommendation in one paragraph

Render locally by default with a **native renderer** (ag-psd parser + our own Canvas/WebGL compositor). It is free, private, works offline and gives instant previews. Every mockup gets a **fidelity self-check**: we re-composite the untouched PSD and compare it with the composite Photoshop stored in the file, so we know per mockup whether our output can be trusted. Keep **Photopea** behind the same interface as the high-fidelity path for mockups that use features we do not reproduce (layer effects on the placeholder, warps, smart filters, adjustment layers). Store libraries in **Google Drive with the `drive.file` scope**, and add a tiny serverless OAuth helper only in Phase 3. No other backend until billing.

## Layers

```
src/plugin/code.ts        Figma main thread: selection, exportAsync, clientStorage. Never edits the document.
src/shared/messages.ts    Typed, validated message protocol (both directions).
src/ui/                   React UI: frame panel, mockup upload, placeholder picker, placement, export.
src/core/geometry.ts      Homographies, quads (pure, unit tested).
src/core/placement.ts     Fit/fill/stretch, scale, rotation, offsets in placeholder pixels (pure).
src/core/export.ts        Scale presets, output size, canvas/memory limits (pure).
src/core/validate.ts      Magic-byte checks for PSD/PSB/EPS, size limits, SHA-256 template key.
src/core/psd/inspect.ts   Smart Object candidates + honest compatibility report.
src/core/render/types.ts  MockupRenderer interface (open, render, dispose).
src/core/render/native/   Compositor (layer stack) + WebGL perspective warp.
src/core/render/photopea/ Photopea iframe bridge + replace-contents script.
(later) src/core/storage/ LibraryStore interface: local, Google Drive.
(later) src/core/billing/ Entitlement checks only; payment UI lives outside the core.
```

Placement is defined in the **Smart Object's own pixel space**; the mockup transform is applied afterwards, so dragging in the preview is converted through the inverse homography and stays correct under perspective.

Export renders from source assets: the frame is re-exported from Figma at the scale the output needs (`designExportScale`), never upscaled from the preview.

## Renderer evaluation

| | Native (ag-psd + WebGL) | Photopea (iframe API) |
|---|---|---|
| Runs in Figma plugin UI | Yes in a sandboxed null-origin iframe in Chromium (tested). Not yet run inside Figma itself. | Needs a nested iframe to photopea.com from the null-origin plugin iframe and `networkAccess`. **Untested**: photopea.com is blocked in the Phase 1 cloud container. |
| Smart Object replacement | Our own: design → placeholder space → exact perspective mapping, placed at the SO's position in the layer stack so shadows/highlights above it still apply. | Real: `placedLayerEditContents`, paste, save, close (Photopea's documented pattern). |
| Fidelity | Raster layers, opacity, fill opacity, common blend modes, raster masks, clipping groups, groups, perspective. **Not**: layer effects, adjustment layers, warps, smart filters, vector masks on pixel layers, knockout. Each is reported per mockup. | Near-Photoshop, including effects, warps and adjustments (Photopea's own claims; to verify on the real sample). |
| Large PSDs | Whole file parsed in memory on the UI thread (move to a Worker in Phase 4). | Handled by Photopea; file copied via postMessage. |
| Export resolution | Any scale within limits; design rendered at full resolution; mockup photo pixels are upscaled above 1×. 4× guarded by memory budget. | `resizeImage` re-renders; placeholder content limited to the SO's native size (as in Photoshop). |
| Cost / terms | Free. ag-psd is MIT. | API free, but the free tier shows ads. Figma's review guidelines forbid ads in plugin UIs, so a public release needs a Distributor (whitelabel, priced by monthly views, per domain) or self-hosting ($500–2000/month per Photopea). Distributor whitelists a domain, so we would host a small page on our domain that embeds Photopea. |
| Data transfer | None. | PSD and design are opened in a third-party web app; requires explicit consent (implemented in the UI). |

Not evaluated yet: Adobe Photoshop API (server-side, real Photoshop, Smart Object replace endpoint) as a paid server option.

## Main technical risks

1. **Fidelity of the native renderer** on real mockups that rely on layer effects or adjustment layers. Mitigation: self-check score per mockup, Photopea fallback.
2. **Photopea inside Figma**: nested iframe from a null-origin sandbox (sandbox flags inherit), ads policy, Distributor domain whitelisting, Photopea availability. Needs a real test on a machine that can reach photopea.com.
3. **Null-origin plugin iframe**: no IndexedDB/localStorage and possibly no `crypto.subtle` (we already fall back to a JS SHA-256). Large PSD caching must use `figma.clientStorage` (5 MB total per plugin) or a UI hosted on our own origin.
4. **Memory at 4×**: a 5000×4000 mockup at 4× is 320 MP, over Chromium's 268 MP canvas limit. We refuse with a clear message; tiled rendering is Phase 4.
5. **PSD variety**: CMYK/16-bit files, PSB, linked or nested Smart Objects, vector Smart Objects. Detected and reported; ag-psd converts CMYK approximately.
6. **Google Drive**: `drive.file` only sees files the user picked or the app created, the Picker needs a non-null origin page, and token exchange needs a server-held secret. Broad scopes (`drive`, `drive.readonly`) are restricted and need a security assessment.

## Storage: Google Drive vs private cloud

Drive (`drive.file`, non-sensitive): files stay in the user's own account (good for licensing and privacy), no storage bill, but needs the Figma OAuth relay flow (small HTTPS endpoint with read/write keys) and a hosted Picker page. Private cloud (R2/S3 + accounts): simpler browsing and caching, but we pay for storage, hold users' licensed assets, and need auth earlier. **Recommendation: Drive for Phase 3**, metadata/thumbnail cache in clientStorage, full PSD downloaded on demand.

## EPS

EPS is a PostScript program with no layers or Smart Objects, and browsers cannot render it; a server-side interpreter (Ghostscript is AGPL or paid commercial licence) would be needed. Supported workflow: convert the EPS to PSD (Photoshop or Photopea) and add a Smart Object placeholder, after which it is a normal PSD template. Optional later "flat template" mode: a raster background plus a user-defined 4-corner placeholder, clearly labelled as a flat overlay without Smart Object effects. Phase 1 detects EPS and explains this.

## Security notes

- Main thread and UI validate every message; templates are schema-checked before storage.
- Files are sniffed by magic bytes and size before parsing; parsing is byte-level only, nothing embedded is executed.
- Photopea messages are accepted only from the frame we created and only from `https://www.photopea.com`.
- No secrets in the plugin. Future OAuth/billing secrets live in a serverless function.
- Mockups are the user's own; nothing is uploaded anywhere by the native path.
