# DesignFree repository guidance

## Purpose and first reads

Build a usable Figma-style editor for personal Docker hosting while retaining CSS/web-development semantics. Read README.md, docs/CODEX_HANDOFF.md and relevant docs/FEATURES.md sections first. Use relative repository paths; never depend on an original author's home directory, private notes or external chat.

## Architecture

- src/core: scene validation, pages, transforms and history.
- Geometry/layout: snapping.ts, arrangement.ts, layers.ts, transforms.ts, text-layout.ts, flex-layout.ts, grid-layout.ts.
- Authoring: components.ts, variants.ts, style-library.ts; preserve source/instance identities and overrides.
- Rendering/export: src/renderers and web-export.ts. SVG default, CanvasKit alternate.
- Storage: use-local-draft.ts, local-draft-storage.ts, server-storage.ts.
- server: owner authentication, PostgreSQL CAS/idempotent commits, assets and migrations.
- tests: see docs/TESTING.md for disposable-server restrictions.

## Workflow

Use gpt-6.1-sol / medium for delegated implementation/review when available; never silently change the requested model. Do not enable autopilot, scheduled continuation or remote publishing without current user authorization.

One effective action is one history step and one committed save. Selection/viewport/hover/previews are not persisted. Cancel restores prior scene and selection; no-ops add no history/save. Keep authored layout meaning separate from computed geometry/renderers. Preserve schema readability, clipping and inherited visibility/locking.

Run npm test and npm run build for source changes, plus meaningful native browser/pixel tests for affected behavior. Independently review substantial changes, repair and re-review findings. Report actual commands/results and limitations; historical performance prose is not fresh evidence.

Never run destructive fixtures, restores, database/asset mutations or down -v against personal data. Use a fresh disposable project with explicit URL/credentials. Keep current user browser tabs and unrelated containers untouched. Do not publicly bind services or weaken authentication for test convenience.

## Privacy

Never commit .env, credentials, sessions/cookies, private documents/images, database dumps/backups, logs, personal account settings, absolute user paths or private chat context. Artifacts belong in ignored test-results/ or work/. Only .env.example and harmless .codex/config.toml are configuration templates. Run npm run test:privacy before publication. Authenticate separately on each machine; do not copy home-directory Codex config/login. Preserve required upstream license attributions.
