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

Nothing is compiled in and no workspace is joined automatically. With no
profile on disk the app runs a first-launch onboarding journey (relay →
device admission → channel), and the only webview-reachable profile write
refuses to run once a profile exists. Channel agents are never configured by
hand: each refresh re-discovers the roster from signed relay events
(kind:39002 membership roles, kind:10100 agent profiles, kind:0 names) via
the same authenticated query path, so roster changes on the relay appear in
every Tower client without any config or agent work (see
`docs/ONBOARDING.md`).

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

## Workspace profile

Since 0.3.0 nothing observable is compiled in. One runtime workspace profile
(`~/.config/control-tower/workspace.json`, override with
`$CONTROL_TOWER_WORKSPACE`) binds the visible workspace name, relay URL,
authorized channels and authors, optional fixed runtime collectors, and the
optional local runtime target. Native code loads and validates the profile on
every refresh; the webview receives only the validated result and can never
supply a relay, host, or command itself. The deterministic `tower` CLI
(`scripts/tower.mjs`, `docs/ONBOARDING.md`) edits the profile atomically with
the same validation rules, so onboarding a new relay or channel is code
execution rather than agent work. On first launch the compiled-era nilor
workspace is written out as the initial profile.

The header always shows the active workspace and relay host; Tower never
silently infers a relay switch from Buzz Desktop.

The next connection milestone is multiple named profiles: switching between
—and later combining—authorized workspaces in one installation while
preserving separate relay/channel authorization.

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
