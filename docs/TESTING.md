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
