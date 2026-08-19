# Agent instructions

- Preserve the standalone-app boundary; do not require changes to the Buzz
  desktop installer for ordinary development or use.
- Target macOS, Windows, and Linux through Tauri 2.
- Keep protocol/domain logic independent of UI and storage adapters.
- Never place long-lived Buzz private keys in browser storage or application
  configuration files.
- Work on feature branches and run the complete repository test suite before
  opening or updating a pull request.
