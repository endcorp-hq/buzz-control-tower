# Architecture

Buzz Control Tower is a standalone Tauri 2 desktop app. It does not patch or
replace the Buzz desktop installer.

## Boundaries

```text
Local Codex rollout JSONL             Buzz relay standard events
  -> native source redactor             -> signed read-only relay adapter
  -> semantic runtime page              -> validated delivery messages
                 \                       /
                  -> DataSource adapter
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
file, raw JSON, prompts, private response-item reasoning, or encrypted content.
UI-visible thinking summaries and local tool parameters/results are retained to
match Buzz's own local activity feed, after source-side credential redaction and
length limits.

## Security direction

- Device-scoped keys stored in the OS keyring
- NIP-98-signed, read-only relay queries
- Strict channel, author, kind, event-id, and signature validation
- No owner key import or reuse
- No inference that public messages expose private turns or supplied context
- Local runtime selection bound to an explicit channel UUID and agent pubkey
- Source-side omission of private response-item reasoning, prompts, encrypted
  content, token counts, and rate-limit metadata
- Credential-redacted local tool parameters/results and UI-visible thinking
  summaries for local activity-feed parity
- Prompt and runtime-context provenance represented only by a short SHA-256
  fingerprint and byte size

No long-lived private key belongs in application configuration, logs, or web
storage.

The first companion-only transport slice is specified in
`RELAY_ACTIVITY.md`.
The first real execution-stream slice is specified in `LOCAL_WORKSTREAM.md`.

## Cross-platform targets

The Tauri shell targets macOS, Windows, and Linux. The UI is responsive and is
kept browser-compatible so a PWA can be added without forking product logic.
