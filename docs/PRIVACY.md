# Publication boundary

Included: original editor/API source, synthetic fixtures/tests, lockfile, licensed font, Docker files, generic Codex guidance and empty environment example.

Excluded: original Git history/author metadata, private documents/uploads/database volumes/backups, .env/generated passwords, owner accounts/hashes/cookies, Codex authentication/global settings/memory/chats, private note vaults, logs/screenshots and machine-specific reports. The initial commit uses a generic contributor identity. The GitHub repository URL necessarily identifies its owner; that handle is not a product credential.

npm run setup creates an ignored local .env with cryptographic randomness and restrictive file permissions where supported, preserving existing files. Editing a password variable does not rotate credentials on an existing PostgreSQL volume. There is no copied owner account; create one yourself in the fresh installation.

Run npm run test:privacy before publishing. It checks tracked/proposed source for private paths, common key/token patterns and forbidden runtime files without printing matching values. It is not a guarantee about arbitrary future changes. Retain required public third-party author/license attributions and distinguish synthetic demo data from user data.

Moving code does not move designs. Transfer selected designs manually as JSON and keep private backups outside Git. Authenticate GitHub/Codex separately on each machine. Never paste credentials into AGENTS.md, config.toml or handoff notes.


Server mode also keeps unresolved request bodies and the latest recovery library,
including embedded images, in this origin's IndexedDB `draftroom-server-outbox`.
It contains no owner password, cookie or session token. It remains after tab close
and session expiry; successful ACK/recovery or explicit confirmed server-version
selection removes it. Logging in again on the same origin can recover it.
Use a trusted browser profile; logout is not a browser-data wipe. Browser data
clearing removes the outbox and can destroy unresolved edits. JSON recovery backups
contain the full design library; store them privately outside Git.
