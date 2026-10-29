# Detailed product behavior

A local T0 design-editor experiment with a serializable scene graph with absolute, Flex and Grid subsets, interchangeable SVG/CanvasKit rendering, and original mobile screen fixtures. It is not a complete Figma replacement. No Figma code or assets are included.

## Run

Tested development runtime: Node 26.0.0 / npm 11.12.1. Dependency versions and transitive resolution are pinned by package-lock.json.

```sh
npm ci
npm run dev
npm test
npm run build
```

The dev server binds to 127.0.0.1. Open the URL Vite prints. `/bench.html` runs the renderer comparison. See the benchmark page and accompanying report for actual measurements and unverified behavior; the model tests alone do not choose a renderer.

## Local Docker prototype

```sh
docker compose -p designfree up --build -d
# open http://127.0.0.1:4173
# stop: docker compose -p designfree down
```

Compose publishes only the editor on loopback. nginx proxies `/api/` to the private API service; PostgreSQL has no published host port. Docker builds select **server storage** (`VITE_DRAFTROOM_STORAGE=server`). Development defaults to the existing browser-only IndexedDB path, so existing local data and tests stay accessible. To develop against a PostgreSQL database:

```sh
# Supply PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD (or DATABASE_URL).
npm run api
VITE_DRAFTROOM_STORAGE=server npm run dev
```

The API host defaults to loopback; Docker overrides it to its private service interface. Vite proxies `/api` to loopback:3000. Switching a storage mode requires a new build/dev process. Server mode does not fall back to IndexedDB on failure and never automatically imports or clears earlier browser drafts. Before upgrading an old browser-only installation, export each document as JSON; import it into the server-mode library to transfer all of its pages/assets. There is no automatic library migration between storage modes.

### PostgreSQL save/load (H01)

A personal installation has **one shared document library**, preserving F01's atomic active/inactive-document snapshot. H02 separates server PNG bytes into the asset volume; the API still hydrates portable PNG documents (see below). `GET /api/library/current` returns `null` for a new database, otherwise `{document, documents, version, updatedAt}`. The initial demo is not written until an edit. The header distinguishes server saving, acknowledged storage, failure and stale conflict. Undo/Redo and committed gestures use the same serialized save queue; transient selection, viewport and previews remain memory-only.

`PUT /api/library/current` accepts `{operationId, expectedVersion, document, documents}`. Creation expects version 0. A PostgreSQL transaction lock covers ledger lookup, version comparison, document/library replacement and operation recording. Success is sent **only after COMMIT resolves**, returning `{operationId, version, updatedAt}`. A reused ID with the same complete request returns its original ACK even after later versions; changed payload/version returns 422. Object-key order is ignored; array order is significant. A new stale operation returns 409 without writing. Invalid documents return 400; the HTTP body limit is 32 MiB (including the library and embedded assets).

An uncertain save retains its immutable operation ID/body through a manual retry. New edits, including Undo to the previously acknowledged state, cannot replace that pending request: its ACK is recovered first, then newer content saves against the confirmed version. A stale conflict stops autosave and retains memory work for JSON export; reload explicitly selects the latest server state. GET failure also stops writes, rather than treating an unread database as empty. Pending/failed edits retain the existing beforeunload warning. The pending request is **session memory**, not a durable browser outbox: closing/reloading loses uncommitted work; committed work loads from PostgreSQL next time. Keep JSON backups.

Data persists in compose volume `designfree_document-data`; ordinary `docker compose down` retains it. `down -v` deletes it. `DRAFTROOM_DB_PASSWORD` changes the initial database password and API credentials together (generated locally in `.env` by `npm run setup`); changing it on an existing volume does not rotate PostgreSQL credentials. Individual PG env variables preserve special characters. This is a single-owner localhost prototype without collaboration or merge. Do not expose it as a public multi-user service. H03 adds owner authentication; H04 below covers coordinated backup/restore and schema upgrades. Physical power-loss recovery and remote exposure remain unverified. The idempotency ledger is retained without pruning; library size and ledger growth are unmeasured.

Run `node tests/server-storage.e2e.mjs` against a **disposable** server installation (default localhost:4173). It modifies the library, uses actual browser controls and independent HTTP reads, and checks concurrent CAS/duplicate operations plus response-path loss _after_ PostgreSQL commit. `DRAFTROOM_URL`, `SERVER_REPORT`, and `SERVER_SCREENSHOT` select runtime/artifacts. The existing local-storage suites run against the default IndexedDB development server.

Docker build and local container startup were verified on ARM64 on 2026-10-26; amd64 remains unverified. Dockerfile pins the actual resolved base manifest digests:

- `node:26.0.0-alpine@sha256:30f5a66e7265ef70aac56b4753ffa7905e54eca1084bc25503893ad8e9273f05`
- `nginx:stable-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951`

The local compose project is `designfree`, serving at `http://127.0.0.1:4173`.

## Model boundary

`src/core` contains only persisted document fields: nodes, image assets and schema version. Selection, hover and viewport belong to the UI. Renderers consume geometry, never implement layout semantics. `layout.mode` defaults to `absolute`; L01/L02 add Flex/Grid subsets with authoring rules separated from computed geometry (see below).

Matrices use Canvas/SVG order `[a,b,c,d,e,f]`, with local-to-world parent multiplication. Reparenting preserves the complete world transform, including rotated/scaled/sheared parents. Hit testing traverses reverse paint order, accounts for ancestor visibility/locking and clipped rounded/ellipse geometry; text uses its authored box rather than glyph outlines. Visual stroke outside a box is not a hit region.

Drag blank canvas with the selection tool to marquee-select fully contained authored boxes. The rectangle starts after 3 CSS screen pixels and works in either direction under zoom/pan. Hold Shift at pointerdown to add hits to the original selection; shrinking the rectangle removes only newly hit layers. Hidden or locked layers and their descendants are excluded. A fully enclosed frame is selected once as a subtree; when a frame is only partially enclosed, eligible descendants are tested instead. Dragging an unselected frame's empty background scopes the marquee to its children. Clicking that background selects the frame; select the frame first (canvas or layer panel) to move it by dragging its background. This keeps child selection available without changing direct object dragging.

Marquee geometry uses transformed authored-box corners in world coordinates, not glyph/ellipse outlines or painted strokes. Fully clipped descendants are excluded using ancestor rectangular clip boxes; rounded clip corners are approximated by those boxes. Partially clipped objects still require containment of the entire authored box. The same selection state drives layer highlights and canvas outlines. Escape, pointer cancellation and window blur restore the pre-gesture selection. Marquee selection creates no document changes, Undo steps, autosaves or unsaved-document warning; its overlay is excluded from exports.

Hold Option (macOS) or Alt (Windows) at pointerdown or before the first significant drag movement to duplicate the selected objects and move the copies. The modifier choice stays fixed for that gesture. Selected parent/child subtrees copy once, preserve local transforms and image references, and respect inherited locks. A modifier click without a drag creates no copy or undo entry. Copy and movement form one undo step; Escape or pointer cancellation removes tentative copies, leaves the source intact, and restores the original selection. Cmd/Ctrl+D keeps its separate 24-unit offset.

With the selection tool active, hold Option/Alt and point at another layer to show red distance guides. Pressing the key after positioning the cursor also works. Measurements use the selection union and each target's world-space axis-aligned bounding box, including nested affine transforms; they do not measure rotated-edge shortest distances or glyph outlines. Labels show document pixels (rounded to two decimals) and stay the same screen size while zooming. Disjoint axes show the gap; containment shows opposing insets; partially overlapping axes show corresponding edge offsets. Zero-distance guides are omitted.

Measurement hit testing follows reverse paint order, rounded/ellipse hit regions, ancestor clipping, and inherited visibility/locking. Hidden or locked targets and their descendants are excluded. Selected subtrees are skipped so an unselected object behind them or their parent frame can be measured. Visible locked selections may serve as the source. Hover never changes document, selection or undo history. Guides disappear on modifier release, stage exit, window blur, input focus, editing, menus, other tools or gestures. The editor-only overlay has no pointer interactions and is absent from SVG/PNG exports. Option-drag duplication retains its existing behavior.

Select two or more visible, unlocked layers to align their left/right/top/bottom edges or horizontal/vertical centers from the inspector. Three or more layers enable equal horizontal or vertical edge gaps. Alignment uses the selected eligible layers' combined world-space bounding box. Distribution keeps the outermost layers fixed, accounts for unequal sizes, and permits negative gaps for overlapping arrangements while preserving spatial order. If equal gaps would reorder objects between the fixed endpoints, that direction is disabled with an explanation; expand the available space or adjust object sizes first. Selected parents and children move once as a subtree; inherited hidden/locked layers are excluded. A single layer does not align to its parent. Nested rotated/scaled/sheared parents are supported. Selection and input focus stay in place, each effective click makes one Undo/Redo step and autosave, and repeated no-op clicks create no history or save. Controls pause during gestures, text editing and draft recovery.

Dragging and bottom/right resizing snap to visible siblings and parent frame edges or centers within 6 CSS screen pixels. Locked layers can be reference targets, but hidden layers and selected subtrees cannot. Move snapping uses the movable selection union in its common parent axes; mixed-parent selections use world axes. Guides follow rotated/scaled/sheared parents and stay one screen pixel wide. Resize preserves the top-left origin and transform, supports the transformed bottom/right handle, and retains the existing 8-unit minimum size. Independently rotated targets use projected bounding boxes in the active axes, not shortest distances between arbitrary angled edges.

Hold Alt/Option or Cmd during a gesture to disable snapping; pressing or releasing either key recomputes the current preview without moving the pointer. Option duplication keeps its existing gesture latch: holding it at gesture start still duplicates, while pressing it after movement only disables snapping. Guides are editor-only and disappear on completion, Escape, pointer cancellation or window blur. Blur cancels the tentative gesture. A completed gesture, including duplication and snapping, creates one Undo and autosave; cancellation creates neither.

PNG export offers 1x, 2x, 3x and 4x, defaulting to 2x. The export menu shows the resulting pixel dimensions, and downloads include the scale (for example, `draftroom-design@2x.png`). Each scale rerenders vector shapes and text at the target resolution rather than enlarging a previously rendered bitmap. Embedded raster images remain limited by their native detail. SVG export remains vector-based.

`DocumentHistory` deep-copies input/output documents at the public boundary. `beginTransaction` → repeated `preview` → `commitTransaction` makes one drag one undo. `cancelTransaction` restores its start. S04 retains reversible node/asset patches with 100-entry and 32 MiB payload limits; see the large-document section for eviction behavior and measured heap scope.

`parseDocument` rejects unsupported versions, malformed numbers/transforms, inconsistent parent/children, cycles, detached nodes, depth >128, counts >100,000, missing image references and external image URLs. Paint/stroke colors accept hex RGB/RGBA only (3, 4, 6 or 8 hex digits), blocking imported SVG URL paint references. Linear gradient endpoints are normalized inputs, multiplied by node width/height into local pixel coordinates before interpolation. SVG uses `userSpaceOnUse` for the same interpolation as CanvasKit; this does not assert native SVG `objectBoundingBox` interpolation semantics. Images are embedded PNG data URLs. This is an offline prototype boundary, not a hardened multi-user upload service; asset byte-level decoding, resource budgets and schema migration remain future work.

## Fixtures and verification

`createDemoDocument()` builds two original 360×700 mobile screens with Korean/English text, nested transformed artwork, clipping, stroke, gradient and a generated 32×32 PNG tile. The tile is generated locally from simple color arithmetic; no remote image is used. Text uses the locally vendored variable Noto Sans KR TTF (SIL OFL); font rendering/IME behavior is verified separately in the browser.

`createBenchmarkDocument(100|1000|10000)` returns that exact total INCLUDING one page root. IDs and geometry are deterministic. Each group is a clipped frame with mixed shapes, text, images, stroke and gradient. The generator does not assert a performance threshold. All generated nodes have `visible:true`; clipping can reduce the number of displayed descendants.

`npm test` exercises nonidentity nested affine roundtrips, reparent world invariance, ancestor hit-test rules, drag undo/redo/cancel, mutation isolation, schema roundtrip, hostile structure rejection and the three exact-size benchmark fixtures. The E06 snapshot has 124 unit tests passing, 11/11 clipboard scenarios on both development and local production, 12/12 marquee browser scenarios on both development and local production, 16/16 snapping browser scenarios, 2/2 production snapping fixture scenarios, 16/16 arrangement browser scenarios, 12/12 baseline interactive browser checks, 9/9 modifier-drag checks, 7/7 spacing checks, 11/11 autosave scenarios, and 24 real IndexedDB storage assertions passing. The composition check dispatches synthetic composition events; physical Korean keyboard/OS IME input remains unverified.

Run the browser scripts from this directory with the dev server already running at `http://127.0.0.1:5173`:

```sh
node tests/editor.e2e.mjs
node tests/feedback-drag.e2e.mjs
node tests/local-draft-storage.e2e.mjs
node tests/autosave.e2e.mjs
node tests/measurement.e2e.mjs
node tests/arrangement.e2e.mjs
node tests/snapping.e2e.mjs
node tests/marquee.e2e.mjs
node tests/clipboard.e2e.mjs
node tests/png-export.e2e.mjs
node tests/png-ui.e2e.mjs
node tests/benchmark.e2e.mjs
```

Run `node tests/snapping-production.e2e.mjs` against the local production container at port 4173; it uses JSON import/export and UI geometry without development hooks. `DRAFTROOM_URL` can override that URL, and `SNAP_SCREENSHOT` can override its screenshot destination.

Run `DRAFTROOM_URL=http://127.0.0.1:4173/ node tests/marquee.e2e.mjs` to verify the same marquee scenarios in the local production container without development hooks. `MARQUEE_SCREENSHOT` optionally captures the active selection rectangle.

These scripts require installed Google Chrome. `CHROME_EXECUTABLE` optionally selects its executable; the default is the standard macOS Google Chrome path. Benchmark output records the tested environment and measurements; read the actual report before drawing renderer performance conclusions.

## License

Original Draftroom code is MIT-licensed; see `LICENSE`. Third-party code and fonts retain their own licenses; see `THIRD_PARTY_NOTICES.md` and `public/fonts/OFL.txt`. This is a prototype source release; it does not configure a public production deployment.

## Vendored font provenance

Unmodified Google Fonts files fetched on 2026-10-26 from the upstream `main` branch (no upstream commit SHA claimed):

- Font: https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf → `public/fonts/NotoSansKR.ttf`; SHA-256 `194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252`.
- Original license: https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/OFL.txt → `public/fonts/OFL.txt`; SHA-256 `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9`.

## Copy and paste

Cmd/Ctrl+C, X and V use native clipboard events. Outside text/number inputs and text editing, copy writes a versioned Draftroom JSON fragment as `application/x-draftroom+json` and `text/plain`, plus vector SVG as `image/svg+xml` and `text/html`. Chrome on macOS was verified to expose JSON plain text and SVG HTML through the real system clipboard; raw SVG/custom MIME preservation and importing into other design tools depend on the browser/application and remain unverified. Paste reads the JSON format only; arbitrary text, SVG and external images are not imported by this command. Native text editing keeps its own clipboard behavior. Document recovery, composition and pointer gestures block design clipboard actions.

Copy selects each subtree once, includes only its referenced embedded PNG assets, and does not create history or autosave. Cut copies before deleting unlocked selection roots. Each cut or effective paste is one Undo/Redo step and follows committed autosave. Paste always creates fresh node IDs using the same subtree remapping as Cmd/Ctrl+D and Option-drag; image asset IDs stay shared when the existing asset matches, while cross-document collisions receive new asset IDs without replacing existing images. Cmd/Ctrl+D retains its 24-unit parent-coordinate offset.

With one frame selected, paste inserts inside it using the copied local coordinates. For roots from different parents, the first copied root's parent supplies common axes so relative affine geometry stays intact. Otherwise paste keeps the copied world position, using the original parent in the same document if it still exists and is unlocked, or the page as fallback. Selection changes to the pasted roots. A selected locked frame rejects paste; invalid clipboard data leaves the document unchanged. Repeated paste creates independent IDs at the same position. SVG bounds include visible subtree boxes and affine strokes; clipped descendants may add whitespace. External font substitution follows the existing SVG export limitations.

Run `node tests/clipboard.e2e.mjs` for actual Chrome system-clipboard and shortcut scenarios. Set `DRAFTROOM_URL=http://127.0.0.1:4173/` for the local Docker build. `CLIPBOARD_REPORT` and `CLIPBOARD_SCREENSHOT` optionally record results and a preview. These tests grant clipboard permissions in an isolated context and use JSON import/export rather than development hooks.

## Groups

Cmd/Ctrl+G groups selected sibling roots; Shift+Cmd/Ctrl+G ungroups selected groups. A single layer can also be wrapped. Selected parent/child subtrees count once. Mixed-parent selections and inherited locks reject grouping atomically. Sibling order is retained inside the group, which occupies the topmost selected sibling's slot; grouping nonadjacent siblings necessarily changes their stacking relative to intervening peers. These are Draftroom defaults, not verified Figma equivalence.

Groups preserve complete affine world transforms on creation and removal. Their bounds are the union of direct children's transformed authored boxes, including hidden/locked children, excluding stroke overflow. Child edits, deletion, reparenting and history previews recalculate nested group bounds from the inside out, adjusting origins without moving other children. Bounds are derived: group resize scales direct child transforms and then recomputes the bounds, preserving the group’s affine axes. Groups paint no shape in either renderer; opacity applies to their subtree. Ungroup rejects hidden, clipped or non-unit-opacity groups rather than silently discarding compositing effects. Restore visibility/100% opacity before ungrouping.

Canvas clicks select the outer group. Double-click enters one group level and selects the hit child; nested groups need another double-click. Inside a group, drag its empty bounds area to marquee-select children. Outside entry scope, marquee treats a group as one target. Escape returns to the containing group; clicking outside exits entry scope. The layer panel can directly select children. Entry scope is transient, excluded from JSON/autosave/history. Group and ungroup each create one Undo step and use committed autosave. Clipboard and duplication preserve the group tree.

Run `node tests/grouping.e2e.mjs`; `DRAFTROOM_URL`, `GROUPING_REPORT`, and `GROUPING_SCREENSHOT` optionally select the runtime and artifacts. Browser tests use native shortcuts and JSON import/export without development state hooks.

## Layer order and parenting

Drag a layer row to its upper/lower edge to insert before/after it in the displayed tree (the tree follows back-to-front paint order). Drop in the middle half of a frame or group row to append inside it; the destination expands after a successful drop. Dragging a selected row moves all selected roots in document paint order. Parent/child duplicates move once. Locked sources/destinations and cycles reject the entire panel move. A row border marks before/after insertion and an outline marks inside insertion.

Cmd/Ctrl+[ moves the selection one sibling step backward; Cmd/Ctrl+] moves it forward, preserving selected sibling order. Each parent is handled independently. Native text inputs, composition, text editing and active canvas gestures keep their own keyboard behavior.

At the end of a canvas move, the pointer chooses the innermost visible, unlocked frame in reverse paint order, excluding moved subtrees and respecting rectangular ancestor clipping. Crossing outside frames moves to the page. Remaining in the same containing frame preserves an existing group parent; groups are explicit panel-drop destinations, never automatic canvas targets. Multi-selection uses the same drop frame for roots that cross a frame boundary. Frame changes occur on drop, preserving the full moved world matrix, including rotation, scale and shear. The move and parent change are one Undo/Redo/autosave transaction; Escape/cancel restores both. Reparenting changes clipping and inherited effects according to the new parent. Rounded clip corners use rectangular target bounds, and Figma behavior equivalence is unverified.

Run `node tests/layers.e2e.mjs` for native panel drag, shortcuts, canvas crossing, Undo/Redo, input protection and autosave checks; `DRAFTROOM_URL`, `LAYERS_REPORT`, and `LAYERS_SCREENSHOT` select runtime/artifacts.

## Rotation and eight-way resizing

Eight handles resize in the selected object's local axes, including affine parents. Opposing edges/corners stay fixed; side handles change one axis. Hold Shift for the starting aspect ratio (side handles center the perpendicular expansion), Alt/Option to keep the center fixed, or both together. Moving axes clamp at 8 authored units without flipping; an untouched smaller axis stays unchanged. Pointer grab offsets are preserved. Small selections use smaller handles to preserve room for moving at practical zoom levels. Handles have a 2-CSS-pixel minimum and can still overlap on extremely small selections; zoom in for precise targeting.

The rotation handle sits 28 CSS pixels beyond the top midpoint. Rotation uses the selection center in world space, preserves the full affine matrix, and Shift snaps the resulting world angle to 15-degree increments. Modifier changes recompute the preview with a stationary pointer. Rotation angles in the single-object inspector use the world orientation of the local X axis, including the parent. W/H remain authored local dimensions, and X/Y remain parent-local origin coordinates. Entering a W/H or rotation value uses the same transformation functions as dragging. Group W/H scale their subtree and recompute derived bounds. A frame's own resize changes its box; scaling a frame as part of a multi-selection scales its entire subtree through its matrix.

Multiple editable selection roots use their world axis-aligned union. Resize applies one world affine scale and rotation uses one shared center, preserving relative geometry across different parents. Selected descendants transform once through their selected ancestor. Hidden/locked roots are excluded. Multi-selection W/H show the editable roots' current union; **rotation Δ° is a relative command**, committed once on Enter or blur, then reset to zero. Escape cancels its draft. The union is recalculated after rotation, so it has no persistent orientation field.

Every completed handle gesture is one Undo/Redo and committed autosave. Escape, pointer cancellation and window blur cancel previews. Numeric changes pause during gestures/text editing/recovery. The existing sibling/parent bottom-right snapping is retained for an unconstrained single non-group resize; Shift/Alt and the other seven handles use exact transformation geometry without resize snapping. Cmd also disables that snapping. Overlays and handles are excluded from exports. No Figma behavior equivalence is claimed.

Run `node tests/transforms.e2e.mjs` for eight directions, live modifiers, affine-parent geometry, rotation, numeric entry, mixed-parent multi-selection, groups, cancellation, locks and recovery. Use `DRAFTROOM_URL=http://127.0.0.1:4173/` for local Docker; `TRANSFORMS_REPORT` and `TRANSFORMS_SCREENSHOT` select optional artifacts. The script uses JSON import/export and native pointer/keyboard input without development state hooks.

## Basic text properties

The text inspector selects family, variable weight 100–900, left/center/right alignment, line height and signed letter spacing in authored pixels. Noto Sans KR is bundled; `serif` and `monospace` use the browser's platform fonts and can vary by machine. Imported unknown families keep their original name, display a missing-font warning, and render with the bundled fallback. Choosing a supported family replaces the missing reference. Arbitrary installed-font discovery and font upload are not implemented.

Sizing modes are fixed width/height (wrap, with visible overflow), automatic width (explicit newlines only; both dimensions follow content), and fixed width/automatic height (wrap and derive height). Wrapping uses grapheme boundaries, including Korean and combined emoji; it deliberately allows breaks within Latin words. Explicit spaces, empty lines and trailing newlines are preserved. Existing documents without a sizing field retain their original explicit-newline behavior until a mode is selected. New text uses automatic height. Resizing a single automatic text box through handles or W/H changes it to fixed sizing, so the requested dimensions and opposing resize anchor remain authoritative. Group/multiple selection scaling keeps the text's sizing semantics and scales its transform.

Shared line layout drives SVG screen output/export and automatic text bounds before enclosing group normalization. The bundled font loads before document recovery so saved automatic dimensions are not measured using a temporary fallback. Text properties and resulting bounds use the existing Undo/Redo, JSON, clipboard and browser autosave paths. Direct editing remains a native textarea with the same font, alignment, spacing and character-break policy; the canvas updates its automatic bounds on commit. Browser typography is not a complete CSS layout engine: hyphenation, bidi paragraph layout and rich-text spans are not implemented or verified.

CanvasKit remains experimental. S03 replaces its synthetic bold/direct glyph path with browser-shaped RGBA text tiles; see the renderer parity section below for measured scope and limitations. SVG export references fonts; PNG embeds Noto Sans KR, while platform-family appearance depends on the rasterizing browser.

Run `node tests/text-properties.e2e.mjs` for native property controls, missing-font status, wrapping, automatic dimensions, direct editing, Undo/Redo, JSON/SVG export and cold reload. `DRAFTROOM_URL`, `TEXT_REPORT`, and `TEXT_SCREENSHOT` select runtime and artifacts.

## Fill stacks, gradients and borders

The inspector adds, removes and reorders up to 32 fills, listed bottom to top. `fills` is optional; old documents use their single `fill`. New edits mirror the first paint into `fill` for compatibility with older readers, which cannot display the complete stack. An empty stack paints nothing. Groups have no own painted shape; image fills are behind the owned PNG and its border is above it. Color fields accept HEX with optional alpha. Paint, gradient-stop and node opacity multiply; node opacity composites the entire subtree once.

Linear endpoints use percentages of the authored width/height. Radial uses the same two points: a center and a point on a **circle in local pixels** (not an elliptical object-bounds gradient). It follows the node's affine transform. A coincident radial point uses a 0.001-unit minimum radius. Stops support color, opacity, position, addition and deletion (2–64 stops). Both renderers stably sort positions, including legacy unsorted stops. Numeric paint edits commit on Enter/blur, Escape cancels; each edit uses the existing history/autosave/JSON/clipboard paths.

Borders support nonnegative thickness, center/inside/outside position, opacity and a space/comma-separated positive dash sequence (up to 16 intervals; empty is solid, odd lists repeat). Inside/outside use a double-width contour clipped to the shape or its complement. Rectangle corners clamp to half the shorter side. Dashed shapes share a canonical path to preserve their origin across SVG and CanvasKit. Text glyph strokes remain centered; the inspector explicitly disables other positions for text. Borders outside the page or a clipped parent can be clipped, and authored hit/group bounds still exclude stroke overflow. SVG screen/export and PNG use the same scene markup. CanvasKit shape pixels are checked with raster fixtures; text parity and the renderer gate are evaluated separately with the S03 fixtures below.

Run `node tests/paints.e2e.mjs` for native controls, history, JSON/SVG/PNG, locks, CanvasKit and reload recovery. `DRAFTROOM_URL`, `PAINT_REPORT`, `PAINT_SCREENSHOT` select runtime/artifacts. Run `node tests/paint-renderers.e2e.mjs` on Vite for full-frame SVG/CanvasKit/PNG comparisons (`PAINT_PIXEL_REPORT` optional); sampled interiors and a bounded mean channel error permit measured antialiasing differences rather than claiming bit-identical engines.

## Renderer text parity (S03)

Both renderers use the browser shaper, real variable-font weights, `geometricPrecision`, explicit normal kerning and the same line layout. CanvasKit composites bounded RGBA text tiles rasterized once in device coordinates, preserving color emoji, gradients, stroke and affine parents. It does not use native Skia paragraph shaping. Integer device translations reuse a tile; fractional phase, zoom, typography and paint changes invalidate it. Clips and subtree opacity remain CanvasKit operations. Tiles include actual ink overhang and stroke padding, and cap at 4096 pixels per side / 4 million pixels. Extreme scales can be sampled. Aggregate tile/native memory and long-text performance remain unprofiled.

The `serif` choice now prefers `"Times New Roman", serif`. Local Chrome's unqualified `serif`/Times SVG and Canvas advances differed; the explicit named stack matched in the measured fixtures. Other systems can choose fallback fonts. Missing authored family names remain preserved and explicitly substitute Noto Sans KR. SVG files still reference fonts; PNG embeds Noto Sans KR. Physical IME, other browsers/OS and arbitrary rich text/bidi paragraphs remain unverified.

Tracking is measured with the authored spacing because spacing can change ligatures/kerning. Intrinsic widths omit the final tracking space. DOM text editing, SVG, PNG and CanvasKit share the resulting layout; this can correct the automatic bounds of existing spaced text on normalization.

Run on Vite, from this repository:

```sh
TEXT_PIXEL_REPORT=test-results/61-text-renderer-pixels.json node tests/text-renderers.e2e.mjs
PAINT_PIXEL_REPORT=test-results/62-common-renderer-pixels.json node tests/paint-renderers.e2e.mjs
TEXT_PIXEL_REPORT=test-results/61-text-renderer-pixels.json PAINT_PIXEL_REPORT=test-results/62-common-renderer-pixels.json node tests/benchmark.e2e.mjs
```

The text suite compares actual SVG DOM screenshots against CanvasKit and PNG: 26 fixtures at DPR1 and DPR2, independent SVG advance checks, ink coverage/bounds, and mean channel error over the ink union. It includes weights 100–900, Korean, Latin kerning/ligatures, combining marks/color emoji, Arabic runs, generic/missing families, signed tracking, wrapping/alignment, overflow, affine/nested clips, alpha and paints. Thresholds allow bounded raster/AA differences; passing does not mean identical pixels for all documents. Evidence includes a source/tests/dependency/font fingerprint and browser version. The benchmark gate requires matching current text and shape evidence plus all six measured cases; a timing-only lab run leaves the gate pending. Passing permits a fixture-scoped renderer comparison, not a final renderer switch or completion of the separate physical-IME T0 check. S04 profiles history JS heap separately. SVG remains the default.

## Large documents and bounded Undo (S04)

The S04 snapshot passes 164 unit tests, all 16 existing development editing/storage/PNG scripts, 67 text/shape pixel fixtures, the six-case renderer gate, and eight native large-document scenarios on both development and local Docker.

History retains reversible whole-node and owned-asset patches, rather than one full document per Undo. Document metadata and hierarchy changes are restored together. Public document/committed-document reads remain detached copies; a gesture still commits once, and net-zero/cancelled gestures retain Redo. The default cap is 100 entries and 32 MiB of serialized UTF-8 patch payloads across Undo/Redo (excluding byte counters and JS object overhead). Oldest entries are evicted on a new edit; a single oversized edit clears the earlier Undo chain and is itself not undoable. This is a memory policy, not durable history. Current documents, transaction bases, defensive copies, native/WASM/GPU allocations are outside that payload budget.

Both renderers skip clipped subtrees conservatively outside the viewport, including affine stroke and antialias margins. Unclipped overflow and text ink are retained. SVG regenerates its visible markup when the document or culled-clip set changes; viewport transforms reuse markup when the set is unchanged. CanvasKit frees resources for culled nodes after each update. Full SVG/PNG exports keep the complete document. This is clipped-subtree culling, not a general spatial index.

The layer tree flattens expanded rows in paint order and renders a scroll window above 500 rows, with eight overscan rows on each side and the existing 33px row height. Collapse, selection, dragging, lock/visibility controls retain their existing handlers. Selecting a layer reveals its row; collapsing an unrelated tree does not jump to an old selection. Flattening and document validation/copying still have costs proportional to document size.

Run with Vite already serving port 5173:

```sh
node tests/large-document.e2e.mjs
node tests/large-document-ui.e2e.mjs
DRAFTROOM_URL=http://127.0.0.1:4173/ LARGE_UI_REPORT=test-results/69-large-document-production-ui.json node tests/large-document-ui.e2e.mjs
```

The first script measures the same exact 1,000/10,000-node mixed fixtures on SVG and CanvasKit: 3 warmups/18 measured samples of synchronous renderer updates, model/history/renderer drag work, and RAF intervals. It also measures JS retained heap after explicit CDP garbage collection before/after 30 committed edits, checking full Undo/Redo restoration. It runs only on Vite because it imports the actual source modules. The native UI script uses JSON file import/export, pointer/wheel input, virtual row scrolling/collapse, one-step Undo/Redo and autosave reload; production uses Vite only to generate fixtures. Its fitted-viewport fixture moves one rectangle to the page front as an unambiguous native target. Native capture-to-two-RAF timing includes React and scheduling; neither script proves presentation latency, GPU time or FPS. Desktop load, GC and small sample sizes limit comparisons. Full-document copies/validation, history commit diffs and autosave serialization remain O(N); 10,000-node editing still has measurable latency.

Regenerate measurements with the scripts above; private historical benchmark reports are not distributed.

## Local documents and pages (F01)

Open **문서 목록** to select, create, rename, duplicate or delete browser-local documents. A new document is blank. Duplication keeps every page and owned image, with a new document identity; layer and asset IDs are scoped to their document. Deletion asks for confirmation and cannot be undone; deleting the final document creates a blank replacement. Rename commits on the form button/Enter and accepts 1–200 trimmed characters. JSON import retains the earlier **replace current document** behavior, preserving other library entries; an imported ID colliding with an inactive document receives a new identity. JSON download backs up the current document including all pages, not the whole library. SVG/PNG export includes the active page only.

The layer panel has ordered page tabs, page addition, rename and deletion. At least one page remains. Page add/delete/rename use normal Undo and autosave. Switching document or page clears selection, group entry and Undo history, then fits the new page; per-page viewport/history retention and page reorder are not implemented. Switching during a pointer/text edit is disabled. Async JSON/PNG reads started in a previous document/page are discarded on transition. Cross-page paste uses the active page when the original parent belongs to another page.

Scene schema v1 remains readable. `migratePages` losslessly creates schema v2 with ordered `pageIds`; `rootId` selects the active page. All page roots and their complete trees are validated and round-trip through JSON and history. No destructive migration occurs on read. The IndexedDB database/store/key stay unchanged; legacy record v1 loads without writing, and the next edit stores record v2 containing the active `document` and inactive `documents`. Future versions, malformed pages and duplicate document identities reject without overwriting the saved record. The whole library and revision are saved atomically using the existing compare-and-swap transaction and serialized writer. Conflicts stop automatic writes and retain memory work. Storage failures retain the last committed library and offer explicit retry. This conservative whole-library snapshot scales with total library size; large-library performance and quota capacity are unmeasured. This section describes the browser-only development storage path; Docker server persistence is described in H01 above. Cross-tab merging is not provided.

Run `node tests/documents.e2e.mjs` for native document/page controls, cross-page clipboard, rapid/in-flight document changes, delete/Undo/reload, delayed image completion and seeded v1 IndexedDB recovery. This suite expects browser-only storage on Vite; server-mode Docker uses `server-storage.e2e.mjs` instead. `DOCUMENTS_REPORT` and `DOCUMENTS_SCREENSHOT` optionally save artifacts. The test uses native controls and JSON downloads, with IndexedDB seeding and delayed browser APIs only for migration/race fixtures.

## Document image asset volume (H02)

PNG uploads remain embedded and portable in editor memory, JSON/clipboard/export and the browser-only development mode. In **server mode**, the same atomic library save writes immutable SHA-256 PNG blobs to `asset-data` before committing JSONB references. A document's directory is the SHA-256 of its document ID; byte-identical images in different documents have separate files. `asset-data` is a named Compose volume mounted at `/app/asset-data` for the non-root API user. Outside Docker, set `ASSET_ROOT` (default `./asset-data`). H01 embedded records load unchanged and migrate on the next successful save. A disk error prevents the library ACK; files left by a rolled-back save become orphan candidates. This is filesystem-before-DB ordering, not a distributed transaction or a verified power-loss guarantee.

`GET /api/documents/:documentId/assets/:assetId` resolves the **current document's own asset inventory**, never an arbitrary digest/path. Unknown documents/assets, another document's asset IDs, and unavailable/corrupt bytes return 404. JSONB contains digests; library GET hydrates portable PNG data. There is no public static volume URL. This enforces document reference scoping within H01's single personal library; there is still no owner login, account ACL or authorization for multiple users. Anyone authorized to use this personal server can read its whole library. Keep the default loopback binding.

The header shows image inventory count, saving/unconfirmed state, and explicit missing count. Missing/corrupt blobs produce a visible checker placeholder and retain their original digest as `asset.missing`; saving that document does not publish placeholder bytes over the missing original. Restoring the original volume bytes clears the warning on reload. Re-adding a PNG creates a new image node. A JSON backup made while bytes are missing contains the warning/reference and placeholder, not the lost original. Full backups must include **both PostgreSQL and asset-data** from a coordinated point. Backup/restore and physical power-loss recovery remain unverified.

Orphan cleanup is explicit maintenance: `POST /api/assets/cleanup` (same origin; no force-delete option). It takes the same PostgreSQL transaction advisory lock as library saves. Every entry in every active/inactive document's `assets` inventory is a live reference, including images whose layer was deleted. Those entries are intentionally retained; there is no unused-image inventory removal UI yet. Deleting a document, replacing its inventory via import, or a failed save can orphan files. The first cleanup observing an unreferenced PNG/temp file creates a durable `.orphan` marker. Cleanup deletes it only after **seven days since that observation**. Any successful reference publication clears the marker, including missing references; a later orphan episode gets a fresh grace period. Time-based deletion uses the server clock. There is no automatic scheduler, directory pruning, storage quota, trash restore or guaranteed expiry while maintenance is not run. Future document-level asset removal must account for Undo and portable copies.

Run `node tests/assets.e2e.mjs` against the local Compose project for native upload, JSONB/disk separation, document scope, missing/recovery and clean API/editor recreation. It uses `docker compose -p designfree` to temporarily move its own fixture blob, restores the baseline library, and does not touch Penpot. `DRAFTROOM_URL`, `COMPOSE_PROJECT`, `ASSET_REPORT` and `ASSET_SCREENSHOT` select the runtime/artifacts. Unit tests use a temporary volume and controlled clock to test actual seven-day cleanup and resurrection; browser recreation tests do not simulate crash or seven days of elapsed wall time.

### Owner and session login (H03)

Server-storage mode requires an owner session before any library, PNG asset or cleanup request. On the first launch, open the installation on localhost and create the single owner (username 1–64 characters, password 12–256 characters). Existing H01/H02 libraries stay in place and become that owner's library. Setup is one-time and atomic; there is no default password, public signup, invitation, account recovery or password-reset UI. Initialize locally before allowing LAN access. Browser-only development mode remains a separate unauthenticated local draft tool.

Passwords are stored as salted scrypt hashes. Opaque random session tokens are stored only as hashes in PostgreSQL; the browser receives an HttpOnly, SameSite=Strict cookie scoped to `/api`. Sessions expire after seven days without sliding renewal. Logging out revokes that session immediately; other devices stay signed in. Owner and sessions survive API/container recreation. After expiry during a save, sign in and press save retry; the pending operation and current document remain in memory. Logout is available after saving finishes; use JSON backup for an unresolved save conflict/error before closing the page.

The default host binding remains `127.0.0.1:4173`, and API/PostgreSQL host ports remain private. To intentionally access from a second device on a trusted LAN after owner setup:

```sh
DRAFTROOM_BIND_ADDRESS=0.0.0.0 docker compose -p designfree up -d
# On the other device, open http://<host-LAN-IP>:4173 and log in as the owner.
# Restore loopback:
docker compose -p designfree up -d
```

`DRAFTROOM_PORT` optionally changes the editor port. The same server library opens after login in another browser/device. This is single-owner access, not live collaboration: reload to see later acknowledged changes; stale simultaneous saves remain blocked by H01 CAS. The device's IndexedDB draft is not imported automatically. For HTTPS termination, preserve the original Host header and set `DRAFTROOM_SECURE_COOKIE=true` in Compose; HTTP LAN mode sends credentials over that LAN without transport encryption. This prototype does not configure TLS or internet exposure. API write requests reject foreign Origin/cross-site metadata. The in-process login/setup budget is 20 attempts per five minutes and two concurrent password derivations; it resets when the API restarts.

Authentication e2e uses a fresh isolated test instance or explicit `DRAFTROOM_TEST_USERNAME`/`DRAFTROOM_TEST_PASSWORD` credentials. Existing server/asset production e2e also use these variables through real session login; no test authentication bypass exists. Never point fixture-writing tests at a valuable personal library.

### Coordinated backups, restore and schema upgrades (H04)

Run from this checkout with Node and Docker Compose available. Use a backup directory **outside the container volumes**; copy completed snapshots off the host for disaster recovery. Snapshots contain the owner password hash, session hashes, document content and PNGs: keep the directory private. Only restore a trusted, unmodified snapshot; the SHA-256 manifest detects accidental corruption, not malicious replacement or SQL.

```sh
# Default project is designfree; COMPOSE_FILE / Compose environment are inherited.
node scripts/backup.mjs backup /absolute/private/backups/2026-10-27
node scripts/backup.mjs restore /absolute/private/backups/2026-10-27
# Another installation:
COMPOSE_PROJECT=draftroom-example node scripts/backup.mjs backup /absolute/private/backups/example
```

The commands require the PostgreSQL service to be running and the current API image to contain H04. They stop editor/API, wait for them to stop, then export the `public` schema (library, complete operation ledger, owner/sessions and migration history) and the matching immutable PNG volume. Do not run other API containers, direct database writers, Compose lifecycle commands or asset cleanup against this installation during maintenance. Pending browser edits are not included: save them first or export JSON. The same-host project lock prevents two copies of this CLI from running concurrently (a deterministic loopback TCP port in 49152–65151; an occupied port causes a safe failure). The `.maintenance/<project>/owner.json` marker survives process death.

A successful backup publishes one directory with `database.sql`, `assets.ndjson` and `manifest.json`; incomplete exports are never published at the destination. Existing destinations are refused. Export validates PNG digest paths and bytes and rejects symlinks. Temporary files and orphan timestamps are omitted; unreferenced PNGs are retained and their seven-day cleanup grace restarts conservatively. Each PNG is limited to 32 MiB; throughput and large-volume capacity are unmeasured.

Restore validates both checksums **before stopping services**, creates a separate `<snapshot>.before-<UUID>` recovery snapshot, then replaces the whole `public` schema inside a PostgreSQL transaction. It stages and replaces PNGs offline, preserving file access for the API user, runs migrations using the installed API image, and only then resumes previously running services. Any caught SQL/asset/migration failure attempts to reinstall the recovery snapshot. If rollback fails, services stay stopped and the maintenance marker names the recovery directory. Keep that directory until the restored library and PNGs have been checked. Restore replaces owner credentials and sessions too; an older backup can bring back a then-valid session or owner password.

After a killed maintenance process, inspect `.maintenance/<project>/owner.json`, select its `recovery` snapshot (or the original known-good snapshot), and explicitly rerun `restore`. The CLI preserves the previous marker and running-service intent, removes leftover asset staging during import and refuses ordinary backup while interrupted maintenance is unresolved. Before recovering, the CLI removes remaining UUID-named API/PostgreSQL maintenance helpers by its project-specific label; terminating a helper stops its asset/SQL workers, and project-scoped PostgreSQL application names allow the CLI to terminate orphan database backends and release transaction locks immediately. It reuses the original pre-restore pair for rollback rather than snapshotting a possibly mixed interrupted state. If that pair is unavailable, the explicitly selected snapshot is the only recovery source and failure leaves services stopped. No other maintenance process may be writing the volume. Do not delete volumes to repair a failed restore. Local `.before-*` snapshots protect against a failed restore, not host/disk loss. Encryption, scheduled retention, remote backup transport and physical power-loss guarantees are not implemented.

API startup now runs ordered schema migrations under a PostgreSQL transaction/advisory lock before listening. Legacy H01–H03 tables are adopted without deleting content; versions 1/2 record the original tables and version 3 adds the session-expiry index. The ledger stores version/name/checksum and rejects changed, missing or future migration history. An upgrade failure rolls back the complete pending plan and prevents the API from serving; fix the migration/image and retry, or restore the pre-upgrade DB+PNG pair using a compatible image. Never modify an already applied migration. Automatic schema downgrade is unsupported. Persisted document versions keep the existing F01 v1-to-v2 parser migration; H04 does not change the document schema.

Before upgrading, create a coordinated backup with the current image, install the new images, and run Compose `up -d --wait`. Test recovery on a disposable project first. `tests/backup-recovery.e2e.mjs` refuses projects outside the `draftroom-h04-test*` prefix; it writes test documents, restores the database and kills all three test containers. Set the same Compose overrides/credentials as the disposable instance. SIGKILL crash recovery is distinct from physical power-loss or disk-failure testing.

## Flex layout subset (L01)

Select a frame and use **레이아웃 설정 → 레이아웃 모드 → flex**. The inspector provides row/column direction, one gap for both axes, four padding edges (top/right/bottom/left), cross alignment, six main-axis justification values, wrap, sizing modes, min/max constraints, and flow/absolute child placement. Fixed source W/H remain editable; the inspector separately shows computed dimensions. Layer ordering shortcuts (Cmd/Ctrl+[ / ]) change flow order. This is a supported subset, not a complete CSS engine or a Figma compatibility claim.

`SceneNode.layout` persists authoring rules alongside authored width/height/transform. `computeLayout(source)` returns a detached geometry document. Renderers, hit testing, marquee, selection/spacing overlays, text editing placement, SVG and PNG consume that result. History, JSON, autosave and the server store authoring values only; computing layout does not create an Undo step or a save. Existing absolute documents need no migration. Flex fields are additive to schema v1/v2; older editor versions that accept only absolute layout cannot open Flex documents. Do not downgrade without JSON backups.

| Mode | Meaning and CSS correspondence |
| --- | --- |
| fixed | Authored border-box dimension, then min/max; main-axis `flex: 0 0 auto`, **no shrinking**. This differs from CSS's default shrink factor 1. |
| fill, main axis | Zero basis, equal grow factor 1, shrink 0, explicit automatic minimum 0, then authored min/max. Corresponding CSS fixture uses `flex: 1 0 0px; min-width: 0; min-height: 0`. It is neither `width: 100%` nor the CSS automatic min-content minimum. |
| fill, cross axis | Fills the content cross dimension (or wrap line), constrained by min/max; parent start/center/end then positions the resulting box. Fixed and hug cross sizes never stretch. `align: stretch` places these explicit-size boxes at start; choose cross fill to stretch. Under a definite nonwrapped parent this can be compared to an explicit 100% cross size. |
| hug | Flex frames derive content size plus padding, text derives intrinsic shaped width or wrapped line height. A row's wrapped hug height and a column's wrapped hug width use final line geometry. For absolute non-text containers and leaf shapes, hug retains the authored dimension; it does not implement CSS block intrinsic sizing. |

Sizing dependencies have explicit fallbacks: a main-axis fill child of a hug parent contributes its authored/intrinsic size instead of recursively asking for all of an indefinite free space. A cross fill under a hug cross dimension or a wrapped line likewise contributes its authored/intrinsic cross size before the line/parent is resolved. These are design-tool rules, **not general CSS intrinsic sizing equivalence**. Changing the parent to fixed makes the available dimension definite. A wrapped line uses main fill's zero/min basis for line breaking; fill can share a line with fixed siblings until their minimum contributions exceed available space.

Padding is inside the box, with its opposing sums as the minimum box dimension even if max is smaller. Negative values, non-finite settings, unsupported enums and min > max are rejected. Defaults: row, gap/padding 0, start alignment/justification, nowrap, fixed dimensions and flow placement. Hidden children consume no layout space (CSS fixture uses display:none); locked children still participate. Absolute children preserve their authored local offsets, consume no flow or hug space, and do not use CSS static-position inference. Rotations/shears/scales affect painting, not allocation of the untransformed box.

Wrapped lines pack at cross-start (`align-content:flex-start`), including when the parent has extra cross space. Oversized explicit center/end alignment keeps negative offsets, while distributed around/evenly overflow falls back to start as measured in Chrome. There are no margins, borders in layout allocation (painted strokes stay separate), percentages, reverse directions, order property, baseline alignment, arbitrary grow/shrink/basis controls, align-self/content controls, or semantic CSS export. L03 adds a fixed computed-box HTML/CSS snapshot preview (see below). Existing grapheme text wrapping and font fallback are reused; punctuation, bidirectional text and CSS line-breaking equivalence are not established by the Korean fixtures.

To avoid writing computed boxes into authoring data, pointer/keyboard transforms, grouping, align/distribute, layer drag/reparent and clipboard copy/cut are conservatively blocked for Flex/Grid-related selections (including ancestor/descendant layouts and min/max). Use the layout inspector, fixed W/H, absolute X/Y, ordering shortcuts, duplicate, delete, text editing and JSON documents. Flex/Grid settings inside groups cannot be created via the inspector; imported mixed group/layout documents are not a supported editing workflow. Switching Flex/Grid off reveals the preserved original positions; it does not bake the last computed positions. Canvas creation still creates a node at page level; no automatic drag insertion into Flex frames is provided.

`node tests/flex-layout.e2e.mjs` compares the pure solver with separately authored actual DOM CSS boxes, including fixed+fill, opposing min/max, Korean text, nested/wrapped hug, padding and overflow. Raw box geometry and tolerance are recorded; no performance or cross-browser guarantee follows. `node tests/flex-ui.e2e.mjs` verifies real inspector edits, source/geometry separation, hit testing, Undo/Redo, absolute children, SVG/PNG, renderer switching and reload. Use `FLEX_SERVER=1`, `DRAFTROOM_URL` and disposable owner credentials for server mode; the test replaces its library fixture. Both suites accept artifact output paths (`FLEX_CSS_REPORT`, `FLEX_UI_REPORT`, `FLEX_SCREENSHOT`). Specification reference: [W3C CSS Flexible Box Layout](https://www.w3.org/TR/css-flexbox-1/); implementation differences above are intentional and fixture-scoped.

## Grid layout subset (L02)

Select a frame, then **레이아웃 모드 → grid**. Columns/rows accept a whitespace-separated list such as `80px 1fr auto` (bare numbers mean px). Areas use semicolon-separated rows, e.g. `head head; nav main`; `.` is an empty cell. Child controls set a named area, positive one-based column/row start lines, and column/row spans. Empty starts use sparse row-major automatic placement. Explicitly positioned children reserve cells first and may intentionally overlap. Per-row cursors keep row-locked auto items from backfilling earlier holes. No dense or column-major mode is provided.

Grid uses the same persisted `SceneNode.layout` and detached `computeLayout` boundary as Flex. `layout.grid` stores `columns`, `rows`, `autoColumns`, `autoRows`, `areas` on containers and `column`, `row`, `columnSpan`, `rowSpan`, `area` on children. Frames can nest Grid and Flex. Absolute/hidden children are excluded from tracks, locked children participate, and transforms affect painting only. Original dimensions/offsets, JSON, history and server storage stay authored; SVG/CanvasKit, hit testing and SVG/PNG exports use computed boxes. Existing absolute/Flex files need no migration; older versions cannot open Grid documents. Back up JSON before downgrading.

| Setting | Supported meaning |
| --- | --- |
| px / bare number | Nonnegative fixed track size. Overflow is retained. |
| `Nfr` | Positive weighted fraction of space left after fixed/auto contributions and gaps. Zero track minimum, comparable to CSS `minmax(0,Nfr)` rather than the default automatic min of bare CSS `Nfr`. Sums below 1 consume only that fraction of remaining space in definite containers. |
| `auto` | Maximum authored/intrinsic child contribution per track; spanning deficits are shared equally across spanned auto tracks in increasing span order. With no fractional tracks, definite leftover space stretches auto tracks equally. This is an explicit editor policy, not the full CSS min/max-content algorithm. |
| implicit tracks | Area dimensions, positive start lines and spans extend the explicit grid. Unspecified columns/rows use `auto`; automatic row/column tracks can be px/fr/auto. Default has one column. |
| named area | Rectangular repeated names; overrides numeric start/span while the name exists. Missing names fall back to numeric/auto placement (CSS implicit named lines are unsupported). Names are ASCII letters/underscore followed by letters, digits, `_` or `-`, maximum 64 characters. |
| child size | fixed/hug retain their dimension; fill stretches to the cell then applies min/max. Horizontal placement is start. Parent vertical start/center/end positions the final item, allowing signed overflow; stretch requires height fill. `justify` and Flex direction/wrap do not affect Grid. |
| hug container | Uses intrinsic tracks, gaps and padding. Weighted fr ratios are retained using intrinsic contributions. Resolved max/min width is applied before measuring text/nested height and allocating rows. Indefinite fractional sizing, especially factors below 1, is an editor policy and not general CSS shrink-to-fit equivalence. |

Fill contributes its authored/intrinsic dimension to auto track sizing, never its allocated cell width/height; otherwise a spanning fill item can consume all space from neighboring fr tracks during row measurement. This differs from CSS empty auto-sized elements and CSS spanning contributions across flexible tracks. Intrinsic text uses existing shaping/wrapping, and fill/hug sizing cycles use authored fallback. Fixed track child overflow, min/max child overflow and container constraints retain the existing border-box padding floor policy. General CSS intrinsic min-content, spanning multi-phase track growth, percentages, `minmax()` input, `repeat()`, auto-fit/fill, subgrid, negative/named lines, margins, layout borders, baseline, writing modes and semantic CSS export/preview remain unsupported. Track arrays and area grids are bounded to 128 per axis; authored starts/spans are positive integers up to 128. Implicit tracks can extend beyond the template bounds. This subset has no large-grid performance guarantee.

Inspector text fields commit on blur/Enter; invalid track grammar, nonrectangular areas, nonfinite/negative tracks, zero fr, and invalid starts/spans are rejected without changing the document. The existing conservative Flex transform/group/reparent/clipboard restrictions also cover Grid and its ancestors/descendants; use layout controls, fixed dimensions, ordering shortcuts, duplicate/delete, text edit and JSON. Imported group/layout mixed editing remains unsupported.

`node tests/grid-layout.e2e.mjs` compares separately authored native CSS boxes with the solver (raw report `GRID_CSS_REPORT`), including px/fr/auto, areas, spans, sparse/implicit placement, fractional sums, padding/gaps, constraints, Korean text, nested Flex and hug sizing. `node tests/grid-ui.e2e.mjs` verifies actual inspector edits, rejection, history, computed hit testing, source preservation, exports, renderers and reload. Use `GRID_SERVER=1`, disposable credentials and `DRAFTROOM_URL` for PostgreSQL mode; `GRID_UI_REPORT` and `GRID_SCREENSHOT` set outputs. These are fixture-scoped Chrome comparisons, not cross-browser or full CSS conformance. Reference: [W3C CSS Grid Layout Level 1](https://www.w3.org/TR/css-grid-1/).

## Frame web preview and CSS export (L03)

Select exactly one **frame**, then **내보내기 → 선택 frame 웹 미리보기**. The dialog renders a sandboxed HTML document; download its standalone HTML (embedded CSS, PNG bytes and bundled Noto Sans KR font) or the matching stylesheet. CSS selectors use generated `dr-*` classes, never imported names/IDs. The stylesheet alone is paired with that HTML's classes; HTML already contains the stylesheet. No script or external resource is needed by the exported page. The OFL notice accompanies the font in the HTML and CSS; the bundled font is licensed under `public/fonts/OFL.txt` (see font provenance above).

This first web export is an explicitly **fixed-size geometry snapshot**, not responsive source generation. Layout is computed from the complete authored document before extracting the selected subtree, including frame sizes inherited from ancestor Flex/Grid. The selected frame starts at local `(0,0)` without its outer transform; descendants retain computed affine transforms. Export never writes computed coordinates into history, JSON or storage. Future semantic Flex/Grid export must separately handle the documented solver/CSS differences.

| Supported subset | Mapping / limits |
| --- | --- |
| Frame, group, rectangle, ellipse | Nested HTML `div`; absolute width/height in CSS px; `matrix()` with top-left origin. Groups have no paint. Ellipse uses 50% border radius. |
| Flex/Grid, fixed/hug/fill, min/max | Resolved to fixed boxes at export time. No `display:flex/grid`, breakpoints, responsive resize, intrinsic reflow or editable layout constraints in output. |
| Visibility, opacity, clipping, corners | Hidden subtrees omitted; nested opacity, `overflow:hidden`, clamped border radius. Root visibility is respected (hidden frame yields an empty body). Ancestor clipping/opacity outside selected frame is excluded. |
| Solid fill stacks | Bottom-to-top RGBA CSS background layers; paint alpha and hex alpha multiply. Text uses its top solid fill. |
| Text | Existing calculated grapheme line breaks become absolutely positioned escaped spans; family fallback, size, weight, tracking, line-height spacing, left/center/right line offsets. Font embedded in UI exports. Browser DOM baseline/raster can differ from editor SVG/CanvasKit; no pixel parity claim. |
| PNG | Owned bytes embedded as `data:image/png`; stretch to computed bounds, inherit corner radius. Missing/invalid bytes fail export visibly. |
| Unsupported styles | Linear/radial gradients and all strokes are omitted with per-node warnings, including text stroke. Multiple text fills reduce to top solid with a warning. No SVG fallback that would imply editable CSS semantics. |

Preview shows a snapshot and limitations from the moment it opens. Close/reopen after editing. It uses an empty iframe sandbox and a restrictive CSP; names and text are escaped, font family uses the existing allowlist/fallback, assets allow only PNG data URLs. No interactions, links, JavaScript, remote fonts/images, SVG import, components/tokens, or accessibility semantics beyond generic named boxes are generated. Cross-browser/OS, huge document export, HTML/CSS pixel equivalence and responsive compatibility remain unverified.

Validation: `npm test`, `npm run build`, `node tests/web-export.e2e.mjs`. The browser fixture exercises actual inspector selection/import/downloads, nested computed Grid/Flex, affine coordinates, warning display, escaped Korean text, embedded font, independent HTML load without HTTP requests, and unchanged JSON/history.

## Components and instances (C01)

Select one ordinary **frame or group** and choose **컴포넌트 생성** in the inspector. A main exposes **인스턴스 생성**; an instance exposes **인스턴스 분리** and **override 초기화**. Creating an instance places a linked sibling 24 authored units away. Duplicate/Option-drag keeps the connection and remaps expanded layer identities. Root placement (the complete affine transform) and initial instance name belong to the instance; other values inherit until edited. Reset preserves placement and restores inherited style/content/name. Detach retains the current expanded geometry/content as ordinary layers. Deleting a main, including its page, detaches surviving instances at their last snapshot and is undoable.

`SceneNode.component` is additive metadata on existing frame/group nodes. A main has `kind: main`; an instance stores a document-local `sourceId`, stable source-to-expanded `nodeMap` and per-source property-path `overrides`. Text content, font size, layout gap and other object leaves override independently; arrays (transforms, paints/stops, padding, tracks) are atomic. Explicit overrides survive a later identical source value and later source changes until reset. If a source removes a stroke that has partial instance overrides, that instance retains the last valid stroke snapshot; restoring the source stroke resumes inheritance of unoverridden fields. Whole-object deletion and leaf overrides supersede each other, so removing and re-adding a local style remains valid. Source child addition/removal/order propagates, surviving nodes retain IDs, and removed-node overrides are discarded. Source changes plus all affected instances form one history command/transaction and one authored save. Renderer/layout/export code consumes the expanded scene without a second component solver.

To nest, move an instance into an ordinary frame/group or a main using the layer panel, then make the containing frame/group a main and create its instances. Inner-source edits and inner overrides propagate through the containing main; outer-instance descendant overrides take precedence. Nested materializations inside an outer instance use its source map rather than independent inner-root metadata: edit any descendant properties or detach/reset the outer root. Independent nested detach, general component swaps, exposed property definitions, cross-document libraries, and component-aware CSS source generation are outside C01. References must be acyclic; self/indirect reference insertion is rejected. Internal structure editing of a linked instance (insert/delete/reparent/reorder/group) requires detaching first. Root instance reparent/delete is supported; source structure remains editable.

JSON/autosave/server storage preserve the document-local links and overrides. Clipboard copy/cut/paste deliberately exports **detached portable snapshots**, including same-document paste; use Duplicate to keep links. Sources are never silently bundled into a clipboard fragment. Existing documents require no migration; older versions are not certified to preserve this new metadata. Missing source imports detach their stored snapshot on load. Imported override paths and map ownership are checked before materialization; malformed effective scene values are rejected. Components add work to the authoring/history boundary; large-component performance and browser/OS compatibility have not been measured.

Validation: `npm test`, `npm run build`, `node tests/components.e2e.mjs`. Use `COMPONENT_SERVER=1`, `DRAFTROOM_URL` and disposable owner credentials for server mode (the fixture replaces its library); `COMPONENT_REPORT`/`COMPONENT_SCREENSHOT` set artifact paths.


## Variants (C02)

On a main component, **Variant 추가** clones a member beside it and establishes a document-local variant set. The first axis is `State` (`Default` / `Variant 2`). **Variant 속성** accepts a JSON object such as `{"State":"Hover","Size":"Small"}`; Enter or blur commits it. Adding/removing an axis updates the entire set atomically, retaining existing member values and initializing new axes from the edited member. Every member must have a unique combination. Empty names/values, unsafe names and more than 32 axes are rejected. The instance inspector's **Variant 전환** selector lists actual members, so incomplete combinations never select an invented variant.

Cloned members share explicit typed layer keys. Switching preserves instance placement, common layer IDs, and leaf overrides independently of layer names/order; unoverridden fields inherit the target. Layers absent in the target retain dormant overrides and recover them when a compatible layer returns, including after JSON/autosave/server reload. Layer-type changes do not apply incompatible overrides. Reset clears active and dormant overrides; detach keeps the current expanded snapshot. A switch and its dependent source propagation form one Undo/Redo operation. Nested authored instances can switch; flattened nested materializations inside outer instances remain governed by the C01 outer-instance boundary.

Ordinary Duplicate of a main creates an independent main outside its variant set, avoiding duplicate combinations. Use **Variant 추가** to extend the set; Duplicate of an instance retains its connection and independent overrides. Clipboard remains a detached snapshot. Combining existing unrelated components, manually mapping unrelated layers, set-wide bulk duplication, exposed properties, shared libraries and general component swapping are not provided. Axes are edited as JSON in this initial inspector. Large variant-set performance, cross-browser/OS and compatibility with older versions remain unverified.

Validation: `npm test`, `npm run build`, `node tests/variants.e2e.mjs`. `VARIANT_SERVER=1` uses the existing disposable authenticated test convention; `VARIANT_REPORT` and `VARIANT_SCREENSHOT` select artifacts.

## Shared styles, tokens and themes (C03)

Open **공통 스타일 · 토큰** in the inspector. Save a selected layer's **색 / 텍스트 / 효과 스타일** and bind an existing style with the corresponding selector. **로컬 값** detaches at the current theme's resolved value. Bound paint/typography controls are disabled; text content and sizing stay local. Source/instance references use the existing component override model. Changing a library or theme is one history command. JSON, local autosave and PostgreSQL snapshots preserve references and authored fallbacks rather than baking the active theme into the document.

The initial library editor accepts JSON with `tokens`, `styles`, `themes` and optional `activeTheme`. Token/style IDs use 1–80 ASCII letters, digits, `_` or `-` (reserved prototype names rejected); display names use 1–200 characters. Entries have `{kind, name, value}`. Kinds are `color` (hex), `text` (complete typography without content/sizing), and `effect` (up to eight sequential drop shadows). Tokens may reference other tokens with `{ "ref": "token-id" }`; a style may use a literal or same-kind token reference. There are at most 512 tokens, 512 styles and 16 themes. All references, including unused tokens and inactive themes/variant overrides, are checked; cycles, missing/wrong-kind references, invalid values and removal of a referenced style are rejected atomically. Theme values override token IDs and resolve aliases in the selected theme; unspecified values use the base token. Selecting **기본 값** removes the active theme selection.

```json
{
  "tokens": {
    "primary": { "kind": "color", "name": "Primary", "value": "#123456" },
    "semantic": { "kind": "color", "name": "Semantic", "value": { "ref": "primary" } }
  },
  "styles": {
    "ink": { "kind": "color", "name": "Ink", "value": { "ref": "semantic" } },
    "body": { "kind": "text", "name": "Body", "value": { "fontFamily": "Noto Sans KR", "fontSize": 16, "fontWeight": 400, "lineHeight": 24 } },
    "raised": { "kind": "effect", "name": "Raised", "value": [{ "type": "drop-shadow", "x": 0, "y": 4, "blur": 4, "color": "#00000040" }] }
  },
  "themes": { "dark": { "name": "Dark", "values": { "primary": "#ddeeff" } } }
}
```

Color styles replace the fill stack with one opaque solid paint; hex alpha remains supported. Typography replaces font family/size/weight/line height and optional tracking/alignment; omitted optional properties revert to their defaults. Styled auto text/group bounds and Flex/Grid geometry are derived after resolution without rewriting authored metrics. Effects use local-space `x/y` (±10,000), `blur` as Gaussian sigma (0–256), hex color including alpha, and sequential source-plus-shadow filtering of the node/subtree. SVG and CanvasKit render the stack; CSS exports use matching `drop-shadow()` filters. Ancestor clipping still applies; effect-bearing documents conservatively disable viewport subtree culling. SVG filter regions include transformed overflowing descendants with a four-sigma padding, not an infinite Gaussian guarantee.

Duplicate retains document-local references. Clipboard emits detached current-theme snapshots, as for components. SVG/PNG and fixed HTML/CSS export show resolved styles; CSS custom properties, responsive theme export, gradient/multi-paint shared color styles, numeric/spacing tokens, per-field typography token expressions, inset/spread/layer blur, cross-document libraries and per-node themes are outside this initial subset. Existing documents require no migration; older apps are not certified to preserve this additive metadata. Large-library performance, other browsers/OS, amd64 and physical IME remain unverified.

Validation: `npm test`, `npm run build`, `node tests/styles.e2e.mjs`, `node tests/style-renderers.e2e.mjs`. Use `STYLE_SERVER=1`, disposable owner credentials and `DRAFTROOM_URL` for authenticated persistence tests; `STYLE_REPORT`, `STYLE_SCREENSHOT` and `STYLE_PIXEL_REPORT` select artifacts.

## Everyday screen acceptance (A01)

A browser acceptance scenario now builds a login form, task list and settings screen from
an empty document through drawing, inspector editing and layer parenting. It covers edits,
Undo/Redo, duplication, SVG/PNG and frame HTML/CSS downloads, reload and library reopening
in IndexedDB and disposable authenticated server modes. See [testing](TESTING.md).
Canceling a drawing gesture restores the previous scene **and selection** without creating
history or an autosave; Escape with no active gesture still clears selection. Export remains
a static design snapshot, and creating inside a frame currently requires explicit parenting
via a layer-panel drop. The scenario exercises absolute layout, not a responsive application.
