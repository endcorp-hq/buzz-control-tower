# Buzz Control Tower

Cross-platform desktop companion for securely navigating Buzz agent activity,
context provenance, workstreams, and delivery evidence.

The application is intentionally separate from the Buzz desktop monorepo and
installer. It targets macOS, Windows, and Linux through Tauri 2.

## Initial product slice

- Channel → workstream → agent navigation
- Live, context, evidence, and artifact detail views
- Fixture-driven domain model with a clean relay-data boundary
- Local-first desktop persistence and secure device identity in later slices

## Run the desktop MVP

Prerequisites: Node.js 20+, Corepack, and the Rust toolchain pinned in
`rust-toolchain.toml`.

```bash
corepack pnpm install
corepack pnpm tauri dev
```

Run the complete repository verification with `corepack pnpm check`.

The first milestone intentionally uses a clearly labeled fixture data source.
It proves the product hierarchy and interaction model without pretending that
relay access grants or durable snapshots are already implemented.

See `docs/ARCHITECTURE.md` for the data and security boundaries.
