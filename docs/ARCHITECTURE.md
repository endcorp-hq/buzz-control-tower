# Architecture

Buzz Control Tower is a standalone Tauri 2 desktop app. It does not patch or
replace the Buzz desktop installer.

## Boundaries

```text
Local Codex rollout JSONL          Doha OpenCode SQLite         Buzz relay events
  -> native source redactor          -> sidecar redactor          -> signed adapter
  -> semantic runtime page           -> Tailscale SSH JSON        -> delivery messages
                 \                     |                         /
                  \_________________ DataSource adapter ________/
  -> validated TowerSnapshot
  -> pure selectors and reducers
  -> React presentation
```

The companion owns a separate device identity in the OS keyring. That identity
can be admitted to a relay and selected channels through existing Buzz
administration. The relay adapter then issues signed, read-only NIP-98 queries
for standard channel-visible events. Fixture mode remains the browser preview
and authorization fallback.

For a local agent, the native runtime adapter selects the newest Codex rollout
whose latest trigger contains both the requested channel UUID and agent pubkey.
It reduces only the latest turn. The React layer never receives the rollout
file, raw JSON, combined prompt envelope, private response-item reasoning, or
encrypted content. The native reducer may isolate the final Buzz event's
human-authored `Content:` field, credential-redact it, and cap it at 4,000
characters for the context drawer.
UI-visible thinking summaries and local tool parameters/results are retained to
match Buzz's own local activity feed, after source-side credential redaction and
length limits.

For mos-agent, a root-owned exporter beside OpenCode opens its SQLite database
read-only and emits the same bounded semantic page. The desktop invokes only a
fixed host and command through the operating system SSH client. Tailscale owns
authentication outside the app; Control Tower stores no VM password, SSH key,
access token, or Buzz key. The remote page is identity-checked and redacted a
second time in native Rust before React receives it.

## Security direction

- Device-scoped keys stored in the OS keyring
- NIP-98-signed, read-only relay queries
- Strict channel, author, kind, event-id, and signature validation
- No owner key import or reuse
- No inference that public messages expose private turns or supplied context
- Local runtime selection bound to an explicit channel UUID and agent pubkey
- Source-side omission of private response-item reasoning, combined prompt
  envelopes, system instructions, memory/canvas bodies, encrypted content,
  token counts, and rate-limit metadata
- Credential-redacted local tool parameters/results and UI-visible thinking
  summaries for local activity-feed parity
- Withheld context represented by a short SHA-256 fingerprint, byte size, and
  explicit reason; isolated human requests and safe runtime fields remain
  inspectable
- Root-owned remote collector registry bounded to the approved MOS channel
- Fixed remote command surface; the webview cannot choose a host or command

## Workspace profiles direction

The current release is one compiled workspace: `buzz.nilor.cool`, the
`buzz-control-tower` and `mos-boston` channels, and one fixed Doha fleet
collector. Changing Buzz Desktop's selected relay does not change Control
Tower's source.

The next connection milestone is explicit workspace profiles. Each profile
will bind a visible name, relay URL, authorized channels and authors, and one
or more fixed runtime collectors. One installation can then switch between
profiles—and later combine authorized profiles—while preserving separate
relay/channel authorization. The active workspace and relay must always be
visible; Tower must never silently infer a relay switch from Buzz Desktop.

No long-lived private key belongs in application configuration, logs, or web
storage.

The first companion-only transport slice is specified in
`RELAY_ACTIVITY.md`.
The first real execution-stream slice is specified in `LOCAL_WORKSTREAM.md`.
The first remote execution-stream slice is specified in
`REMOTE_WORKSTREAM.md`.

## Cross-platform targets

The Tauri shell targets macOS, Windows, and Linux. The UI is responsive and is
kept browser-compatible so a PWA can be added without forking product logic.
