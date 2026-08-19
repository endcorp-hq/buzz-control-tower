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

See `docs/ARCHITECTURE.md` once the first implementation branch lands.
