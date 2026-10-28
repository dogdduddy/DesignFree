# DesignFree

Figma-style open-source design editor for personal Docker hosting. The UI currently uses the Draftroom name. React/TypeScript with SVG and CanvasKit rendering, absolute/Flex/Grid layout subsets, component instances/variants and shared styles/tokens/themes. MIT licensed; no Figma code or assets are included.

## Run on another machine

Install Docker with Compose v2 and Node.js **26** (tested version pinned in `.nvmrc` and `.node-version`). This GitHub repository is public; cloning does not require copying any GitHub credentials.

```sh
git clone https://github.com/dogdduddy/DesignFree.git
cd DesignFree
npm run setup
npm run start:docker
```

Open **http://127.0.0.1:4173/** and create your own owner account on first launch. No account or default owner password is copied. Setup creates an ignored `.env` with a random database password without displaying it; rerunning preserves it. Docker installs dependencies inside the images, so host `npm ci` is unnecessary for this route. Editing `.env` does not rotate credentials on an existing PostgreSQL volume.

Only the editor is published on loopback. API/PostgreSQL stay private. Documents and images use named volumes. `npm run stop:docker` keeps them; **do not use `down -v` for a valuable installation**. A fresh clone starts empty because private documents, accounts, backups and uploads are excluded. Transfer selected designs yourself using JSON export/import.

## Develop and test

```sh
npm ci
npm run doctor
npm test
npm run build
npx playwright install chromium
npm run dev
```

Development opens **http://127.0.0.1:5173/** using browser-only storage. In a second terminal, run `npm run test:browser`. Tests use bundled Chromium across macOS/Linux/Windows; `CHROME_EXECUTABLE` intentionally overrides it, and `PLAYWRIGHT_CHANNEL` selects a browser channel. Linux may need `npx playwright install --with-deps chromium` with administrator privileges for system packages.

Docker builds use authenticated PostgreSQL storage. For server development set PG environment variables or `DATABASE_URL`, start `npm run api`, and start Vite with `VITE_DRAFTROOM_STORAGE=server`. Vite proxies `/api` to loopback:3000. Storage modes have separate libraries; switching never silently uploads or clears browser drafts.

Run `npm run test:privacy` before committing. Generated screenshots/reports/downloads belong in ignored `test-results/`. Authenticated fixture suites need an explicitly selected **disposable** instance; see [testing](docs/TESTING.md).

## Continue with Codex

Open this repository folder in your installed Codex app/CLI and sign in separately. Suggested first prompt:

> Read AGENTS.md and docs/CODEX_HANDOFF.md. Check the repository and environment, then continue the requested task. Do not enable autopilot or publish further changes unless requested.

`AGENTS.md`, architecture notes and test commands travel with the code. `.codex/config.toml` contains only requested `gpt-6.1-sol` / `medium` defaults; project configuration applies after repository trust. No Codex login, API token, global configuration, private memory/vault, old chats or scheduled automations are included. The product requires no OpenAI API key.

- [Architecture and continuation](docs/CODEX_HANDOFF.md)
- [Detailed behavior](docs/FEATURES.md)
- [Testing](docs/TESTING.md)
- [Privacy boundary](docs/PRIVACY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

This is a prototype: live collaboration, general Figma import, advanced prototyping, physical IME and cross-platform verification need further work. Read feature limitations before assuming Figma equivalence.
