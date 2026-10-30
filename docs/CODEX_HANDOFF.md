# Portable continuation handoff

## Current state

This initial snapshot includes the latest local product working tree, including shared styles/tokens/themes. Before export it passed 320 unit tests across36 files and a TypeScript/Vite build. Portability changes are validated separately. Private Git history/chats, accounts, databases and uploads are not distributed.

Implemented: selection/marquee, snapping/guides, clipboard/grouping/parenting, affine resize/rotation, text/paint controls, alignment/distribution, JSON/SVG/PNG/web exports, document/page library, authenticated PostgreSQL/asset persistence, backups/migrations, Flex/Grid subsets, components/variants, styles/tokens/themes. These are scoped subsets, not complete Figma equivalence.

Vite defaults to IndexedDB; Docker uses server mode with a single owner/shared library. Modes are separate and require manual JSON transfer. Server saves use expected version and immutable operation ID, ACK only after PostgreSQL COMMIT, and an IndexedDB durable outbox with explicit uncertainty/conflict recovery. Image bytes use a separate volume. Read FEATURES.md for retry and restore semantics.

SVG remains default. CanvasKit uses browser-shaped text tiles. Performance/parity claims need freshly generated fingerprinted fixtures. Physical Korean IME, all OS/browsers, arbitrary rich text/bidi and GPU memory are not certified. Flex/Grid meaning is authored separately from computed geometry. HTML/CSS exports a responsive Flex/Grid subset with named intrinsic fallbacks; see FEATURES.md.

## Remaining work to assess, not automatic authorization

- Physical IME, native x86 hardware and Linux/Windows desktop validation (AMD64 Docker emulation smoke/storage passed; see TESTING.md); large-document/component/style-library performance.
- Numeric/spacing tokens, cross-document libraries and wider paint/effect support. Visual variant/style/token/theme editors are implemented; see FEATURES.md for their scoped behavior.
- Framework component generation, dynamic exported text reflow, wider responsive intrinsic sizing and remaining layout semantics. W02 exports CSS variables/theme sets and static component templates.
- Collaboration/permissions/prototyping and broader SVG/Figma import.
- TLS/remote deployment hardening and further server resource limits when requested.

Start by inspecting Git, npm run doctor, relevant code/tests. Continue the user's requested task; do not restart completed work or schedule background work. Keep real product data separate from fixtures.

## Verification and conventions

npm ci; npm test; npm run build; npm run test:privacy.

Install Chromium with npx playwright install chromium, start npm run dev, then run relevant tests in a second terminal. npm run test:browser is the editor smoke suite. See TESTING.md for disposable server requirements.

[Repository guidance](https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex) and [project config](https://learn.chatgpt.com/docs/config-file/config-basic) describe the Codex conventions. These files do not replace per-machine installation, login, trust or execution permissions.
