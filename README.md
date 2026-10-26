# Simock

Figma plugin: select a frame, pick one of your PSD mockups, the frame replaces the mockup's Smart Object, adjust placement, export PNG/JPG.

Status: Phase 1 (feasibility). See [PROGRESS.md](PROGRESS.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run in Figma (desktop app)

```bash
npm install
npm run build
```

Figma desktop → Plugins → Development → Import plugin from manifest… → choose `manifest.json`. Select a frame, run **Simock (dev)**, drop a `.psd`.

## Hosted UI (mockup library)

The bundled UI cannot store files (Figma gives plugin iframes a null origin). Publishing `dist/ui.html` to your own URL lets the UI keep a local mockup library in IndexedDB:

```bash
SIMOCK_UI_URL=https://you.github.io/simock/ npm run build   # also adds the origin to manifest.json
```

`.github/workflows/pages.yml` does this automatically on push to `main` (enable Pages → GitHub Actions in the repo settings). Without the hosted page, the plugin still works; mockups are just not remembered.

## Tests

```bash
npm test                 # unit tests (geometry, placement, export limits, validation, messages)
npm run harness          # synthetic PSD suite in headless Chromium; add a path to test a real PSD:
node harness/run.mjs ~/Mockups/phone.psd
npm run ui-smoke         # UI in a sandboxed iframe with a mock Figma host
npm run hosted-smoke     # hosted-UI redirect + library, simulated figma.com and hosted origins
npm run harness:photopea # Photopea renderer (needs access to www.photopea.com)
```

Harness scripts need Playwright with Chromium (`npm i -D playwright && npx playwright install chromium` on a local machine). Outputs land in `harness/out/`.
