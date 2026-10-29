# Tests and disposable data

Use Node26, npm ci, npm test and npm run build. Install Chromium with npx playwright install chromium (Linux may need --with-deps). Start npm run dev, then npm run test:browser or a relevant tests/*.e2e.mjs script. CHROME_EXECUTABLE overrides the binary, PLAYWRIGHT_CHANNEL selects a browser channel. Default artifacts go to ignored test-results/.

Renderer/layout fixtures import /src modules and need Vite. DRAFTROOM_URL selects a different editor URL; several renderer-only suites use EDITOR_URL. Server fixtures require explicit DRAFTROOM_URL and DRAFTROOM_TEST_USERNAME/DRAFTROOM_TEST_PASSWORD. Use only a disposable owner/installation; there is no test bypass.

Assets additionally requires a disposable COMPOSE_PROJECT beginning designfree-test- or draftroom-test-. Backup/recovery retains its draftroom-h04-test prefix guard. Never run fixture imports, resets, container recreation or restores against a personal library.

Example in a fresh POSIX shell (set equivalent environment variables in PowerShell):

```sh
npm run setup
DRAFTROOM_PORT=43173 docker compose -p designfree-test-smoke up --build -d
export DRAFTROOM_URL=http://127.0.0.1:43173/
export COMPOSE_PROJECT=designfree-test-smoke
export DRAFTROOM_TEST_USERNAME=test-owner
# Set a unique local DRAFTROOM_TEST_PASSWORD of at least12 characters.
# Never store it in Git or shared transcripts.
node tests/auth.e2e.mjs
node tests/server-storage.e2e.mjs
```

Clean up only that named disposable project. Unit tests do not prove browser pixels or database durability. Renderer gates need freshly regenerated matching source fingerprints. Historical performance prose is not portable benchmark evidence. Record actual environments/results without private runtime artifacts.

## Everyday screen acceptance (A01)

With Vite running, use `DRAFTROOM_URL=http://127.0.0.1:5173/ npm run test:daily-screens`.
Run it twice to check repeatability; set `A01_RUN=1` / `A01_RUN=2` to retain separate reports.
Each invocation owns a fresh Chromium context and IndexedDB library.
`npm run test:daily-screens:server` builds the production bundle in a fresh
`designfree-test-a01` Compose project on loopback port 43171, runs the same suite twice
against the retained disposable server library, and removes only that project's containers,
network and volumes in `finally`. It refuses existing containers/volumes with that project
label or an occupied port. It pins `compose.yaml`, ignores `.env`/Compose overrides, and
generates test owner/database credentials in process environment only. Docker must be running.
Set `A01_REGRESSIONS=1` to also run auth and server-storage regression suites before cleanup.
No personal installation or open browser tabs are used. If interrupted by an uncatchable kill,
inspect and clean up only `designfree-test-a01` before retrying; the runner refuses leftovers.

`tests/daily-screens.e2e.mjs` creates a blank document and authors Login, List and Settings
pages using drawing tools, inspector inputs and native layer-panel drags. No scene import,
application state setter or source-module fixture is used. It checks text and frame ownership,
edit/Undo/Redo, durable revision increments, no-op/cancel without writes or history,
SVG and PNG downloads, sandbox preview and standalone HTML/CSS, document duplication,
copy isolation, reload and original page reopening. Server setup/login uses the real browser
form. JSON downloads and storage reads observe results only. Each mode reports 11 checkpoints;
artifacts are under ignored `test-results/a01-*`. This covers the absolute-layout workflow in
bundled Chromium; responsive export, Flex/Grid authoring, physical IME and other browsers/OS
need their own acceptance scenarios.

## AMD64 Docker emulation (P01)

Run `node tests/amd64-server.mjs` with Docker Engine 29+ (platform-specific image
inspection), Compose v2, dependencies and bundled Chromium installed. The runner owns
`designfree-test-p01` on `127.0.0.1:43172`. It refuses existing project resources,
including exact-name volumes/network without matching labels, and an occupied port.
It explicitly selects `compose.yaml`, ignores `.env` and implicit Compose overrides,
generates owner/database credentials only in process environment, and forces
`linux/amd64` on editor, API and PostgreSQL. No personal installation or browser tab
is used. It removes only its containers/network/volumes in `finally`; images/build
cache remain. After an uncatchable interruption, inspect only this project's leftovers
before retrying.

It builds editor/API, asserts image `linux/amd64` plus runtime `uname -m = x86_64`,
runs auth (9 scenarios) and server-storage (10 scenarios) browser regressions, then
renames a document through the UI and asserts exactly one version increment. It
removes all three containers with volumes retained, starts them again, logs in from
a fresh Chromium process and compares the full API library and downloaded document
JSON with the acknowledged snapshot. Artifacts stay in ignored `test-results/p01-*`;
no owner credentials, cookies or session state are written.

Verified 2026-10-29: macOS 26.5.1 ARM64 host, Docker Engine 29.1.2,
Compose 2.40.3-desktop.1, Linux aarch64 Docker VM, Node 26.0.0 / npm 11.12.1,
host Chromium 156.0.8078.4. All three containers reported `x86_64` with AMD64
image metadata. First-owner creation, auth/storage regressions, UI save and exact
reload after recreation passed; disposable volumes/network were removed.

| Service | Platform-qualified Docker image ID | Recorded RepoDigest |
| --- | --- | --- |
| editor (`linux/amd64`, runtime `x86_64`) | `sha256:59f49609ee3da93a3787cdaebea843b6beb53f13acb6e692c1c4b68347bba32b` | `designfree-test-p01-editor@sha256:4b52315dbb8d59e7a7b2efb6dd4f83ac3512947cf8069634c775a481409154f4` |
| api (`linux/amd64`, runtime `x86_64`) | `sha256:ad67ccbac18c5ce1b2fe93f5d8f74f0cfc66c83bc62c02403bc384d7c5baf970` | `designfree-test-p01-api@sha256:c583b58eeb9737fce97906b5b798dd80b8f77c34a788ab55d3b21720342ecadd` |
| postgres (`linux/amd64`, runtime `x86_64`) | `sha256:3cec7eb015ba8adb28139fa5c83b8489cdf0e666e53dfdf20f598ae0cc8739e3` | `postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3` |

Values are locally recorded image IDs and repository digests. Editor/API images
were built locally and were not published; PostgreSQL uses the pinned upstream image.
The host browser ran on ARM64. Native x86 hardware, Windows/Linux desktop browsers,
physical IME, power-loss durability, performance and comprehensive AMD64 feature
coverage remain **unverified**. Emulation success is not native-machine certification.

## Flex/Grid canvas flow (L04)

With Vite on loopback, run `DRAFTROOM_URL=http://127.0.0.1:5173/ node tests/flow-drop.e2e.mjs`.
For isolated production/PostgreSQL coverage run `node tests/flow-drop-server.mjs`.
The runner refuses pre-existing `designfree-test-l04` resources (including same-name
volumes/network) or an occupied loopback port 43175, ignores personal `.env` and
implicit Compose overrides, and creates fresh owner/database credentials only in
process environment. It runs L04 flow acceptance plus existing Flex/Grid UI,
auth and server-storage suites, and removes only that disposable project in `finally`.
No personal installation or existing browser tab is used. Reports/screenshots stay
under ignored `test-results/`; `FLOW_REPORT` and `FLOW_SCREENSHOT` override L04 paths.
Pure CSS comparison suites require Vite and use `EDITOR_URL`, not `DRAFTROOM_URL`.
