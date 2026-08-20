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
- The bounded, credential-redacted human-authored `Content:` field from the
  triggering Buzz event when it can be isolated from the runtime envelope
- Safe runtime fields such as workspace name, model, approval policy, and
  sandbox policy
- Fingerprints, sizes, and visibility reasons for base/system instructions,
  durable memory, canvas state, and the surrounding thread envelope
- Signed Buzz messages from the existing relay adapter as delivery evidence

## Source redaction

The native boundary never exports:

- private response-item reasoning, encrypted reasoning, or chain-of-thought
- the raw combined user prompt, system instructions, durable memory, canvas
  body, or surrounding thread envelope
- encrypted model content
- token counts or rate-limit metadata
- file contents or patch bodies

The isolated Buzz request, local tool commands, working directories, results,
thinking summaries, runtime fields, and user-visible agent updates pass through
credential-pattern redaction and length caps before they cross the Tauri
boundary. Full 64-character hex tokens are also withheld because a generic
observer cannot reliably distinguish public identifiers from private key
material by shape alone. Tool and context details are expandable in the desktop
UI.

## Boundaries

It does not infer commits, pull requests, merges, or deployments from shell
activity; those stages require explicit signed evidence.

Remote OpenCode runtimes use a separate sidecar contract described in
`REMOTE_WORKSTREAM.md`; local rollout files are never copied to that path.
