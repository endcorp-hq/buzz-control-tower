# Architecture

Buzz Control Tower is a standalone Tauri 2 desktop app. It does not patch or
replace the Buzz desktop installer.

## Boundaries

```text
Buzz relay standard events
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

## Security direction

- Device-scoped keys stored in the OS keyring
- NIP-98-signed, read-only relay queries
- Strict channel, author, kind, event-id, and signature validation
- No owner key import or reuse
- No inference that public messages expose private turns or supplied context

No long-lived private key belongs in application configuration, logs, or web
storage.

The first companion-only transport slice is specified in
`RELAY_ACTIVITY.md`.

## Cross-platform targets

The Tauri shell targets macOS, Windows, and Linux. The UI is responsive and is
kept browser-compatible so a PWA can be added without forking product logic.
