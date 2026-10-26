# Simock

Figma plugin: select a frame, pick one of your PSD mockups, the frame replaces the mockup's Smart Object, adjust placement, export PNG/JPG.

Status: Phase 1 (feasibility). See [PROGRESS.md](PROGRESS.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run in Figma (desktop app)

```bash
npm install
npm run build
```

Figma desktop → Plugins → Development → Import plugin from manifest… → choose `manifest.json`. Select a frame, run **Simock (dev)**, drop a `.psd`.

## Tests

```bash
npm test                 # unit tests (geometry, placement, export limits, validation, messages)
npm run harness          # synthetic PSD suite in headless Chromium; add a path to test a real PSD:
node harness/run.mjs ~/Mockups/phone.psd
npm run ui-smoke         # UI in a sandboxed iframe with a mock Figma host
npm run harness:photopea # Photopea renderer (needs access to www.photopea.com)
```

Harness scripts need Playwright with Chromium (`npm i -D playwright && npx playwright install chromium` on a local machine). Outputs land in `harness/out/`.
