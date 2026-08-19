# Architecture

Buzz Control Tower is a standalone Tauri 2 desktop app. It does not patch or
replace the Buzz desktop installer.

## Boundaries

```text
Buzz relay / observer archive
  -> DataSource adapter
  -> validated TowerSnapshot
  -> pure selectors and reducers
  -> React presentation
```

The initial milestone uses a fixture `DataSource`. A relay source can replace it
without changing presentation components.

## Security direction

- Device-scoped keys, paired to a Buzz identity
- NIP-42 relay authentication
- Agent-signed, NIP-44-encrypted observer frames
- Owner-signed grants scoped by viewer, agent, channel, visibility tier, and
  expiry
- Source-side redaction before encryption
- Ephemeral live activity plus durable encrypted work snapshots

No long-lived private key belongs in application configuration, logs, or web
storage.

## Cross-platform targets

The Tauri shell targets macOS, Windows, and Linux. The UI is responsive and is
kept browser-compatible so a PWA can be added without forking product logic.
