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
- Source-redacted local Codex runtime workstream for the selected agent

## Run the desktop MVP

Prerequisites: Node.js 20+, Corepack, and the Rust toolchain pinned in
`rust-toolchain.toml`.

```bash
corepack pnpm install
corepack pnpm tauri dev
```

Run the complete repository verification with `corepack pnpm check`.

The native app first looks for the selected agent's matching local Codex
rollout. It reduces the current turn into lifecycle, tool, file-change,
provenance, and artifact events before anything crosses the Tauri boundary.
Raw prompts, private model reasoning, encrypted content, token counts, and rate
limits are discarded. The local owner view retains the same UI-visible thinking
summaries, tool parameters, and tool results available in Buzz's local activity
feed, with credential-pattern redaction and length limits. When the independent
device identity is also authorized, ordinary signed Buzz messages are attached
as delivery evidence through the existing read-only `/query` interface.

If no matching local runtime is active, the app falls back to the signed public
message view; if neither source is available, it uses clearly labeled fixture
data. It never copies the owner's Buzz key.

See `docs/ARCHITECTURE.md` for the data and security boundaries.
The local execution contract is specified in `docs/LOCAL_WORKSTREAM.md`.
