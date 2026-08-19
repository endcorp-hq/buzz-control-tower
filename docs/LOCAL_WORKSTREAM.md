# Local workstream

The first real observability slice reads the selected local Codex agent's
append-only rollout JSONL. It is companion-owned and requires no Buzz source or
installer changes.

## Selection

The native adapter searches only the current user's `.codex/sessions`
directory. It considers at most 64 recent JSONL files, refuses files larger
than 256 MiB, reads only the newest 8 MiB of each candidate, does not follow
symlinks, and selects a session only when its latest triggering message
contains both the requested Buzz channel UUID and agent pubkey. Only the latest
turn is reduced.

## Exported semantics

- Turn started, request received, working, and completed lifecycle
- User-visible agent progress and final updates
- Tool start/return with the visible command, working directory, and result
- UI-visible thinking summaries already exposed by Buzz's local activity feed
- Successful or failed file-change summaries
- Workspace-relative artifacts
- Trigger and runtime-context fingerprints, sizes, and visibility
- Signed Buzz messages from the existing relay adapter as delivery evidence

## Source redaction

The native boundary never exports:

- private response-item reasoning, encrypted reasoning, or chain-of-thought
- raw user prompts, system instructions, or durable memory
- encrypted model content
- token counts or rate-limit metadata
- file contents or patch bodies

Local tool commands, working directories, results, thinking summaries, and
user-visible agent updates pass through credential-pattern redaction and length
caps before they cross the Tauri boundary. Full 64-character hex tokens are
also withheld because a generic observer cannot reliably distinguish public
identifiers from private key material by shape alone. Tool details are
expandable in the desktop timeline.

## Honest limitations

This slice observes a local Codex runtime only. Remote agents need the same
reducer deployed beside their runtime and a separate authenticated transport.
It does not infer commits, pull requests, merges, or deployments from shell
activity; those stages require explicit signed evidence.
