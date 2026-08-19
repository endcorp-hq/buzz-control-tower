# Buzz Control Tower

Cross-platform desktop companion for securely navigating Buzz agent activity,
context provenance, workstreams, and delivery evidence.

The application is intentionally separate from the Buzz desktop monorepo and
installer. It targets macOS, Windows, and Linux through Tauri 2.

## Initial product slice

- Channel → workstream → agent navigation
- Live, context, evidence, and artifact detail views
- Fixture-driven domain model with a clean relay-data boundary
- OS-keyring device identity and a read-only standard-event relay adapter

## Run the desktop MVP

Prerequisites: Node.js 20+, Corepack, and the Rust toolchain pinned in
`rust-toolchain.toml`.

```bash
corepack pnpm install
corepack pnpm tauri dev
```

Run the complete repository verification with `corepack pnpm check`.

The app falls back to a clearly labeled fixture data source when its independent
device identity has not been admitted to a Buzz relay and channel. Once
authorized, it polls Buzz's existing signed `/query` interface for ordinary
channel-visible events. It does not copy the owner's Buzz key and does not claim
access to private agent turns, prompts, tool calls, or supplied context.

See `docs/ARCHITECTURE.md` for the data and security boundaries.
