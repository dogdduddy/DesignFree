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
