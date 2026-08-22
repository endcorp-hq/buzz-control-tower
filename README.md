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
- Source-redacted fleet workstreams through forced-command SSH collectors
- One runtime workspace profile driving every relay, channel, author, and
  collector binding, edited by the deterministic `tower` CLI
  (`docs/ONBOARDING.md`) — adding a channel needs no rebuild

## Run the desktop MVP

Prerequisites: Node.js 20+, Corepack, and the Rust toolchain pinned in
`rust-toolchain.toml`.

```bash
corepack pnpm install
corepack pnpm tauri dev
```

Run the complete repository verification with `corepack pnpm check`.

The native app reads the selected local Codex rollout and the configured remote
MOS agent sessions. Each source reduces its current turn into lifecycle,
tool, file-change, provenance, and artifact events before raw runtime data can
reach the Tauri webview. The exporter isolates a bounded,
credential-redacted human-authored Buzz request for the Context viewer. The
surrounding raw prompt envelope, private model reasoning, encrypted content,
token counts, and rate limits are discarded. The local owner view retains the
same UI-visible thinking
summaries, tool parameters, and tool results available in Buzz's local activity
feed, with credential-pattern redaction and length limits. When the independent
device identity is also authorized, ordinary signed Buzz messages are attached
as delivery evidence through the existing read-only `/query` interface.

Context cards are interactive. They show the isolated request, safe runtime
fields, source integrity metadata, and explicit reasons for any body withheld at
source. Base/system instructions, durable memory, canvas bodies, and the full
thread envelope are fingerprinted but not copied into the companion.

If no matching local runtime is active, the app falls back to the signed public
message view; if neither source is available, it uses clearly labeled fixture
data. It never copies the owner's Buzz key.

See `docs/ARCHITECTURE.md` for the data and security boundaries.
The local execution contract is specified in `docs/LOCAL_WORKSTREAM.md`.
The fleet execution contract is specified in `docs/REMOTE_WORKSTREAM.md`.
Dany's shared-node Windows handoff is specified in `docs/DANY_SETUP.md`.
