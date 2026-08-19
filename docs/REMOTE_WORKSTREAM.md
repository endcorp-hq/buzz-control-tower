# Remote workstream

The first remote observability slice connects Control Tower to `mos-agent` on
the Doha VM without modifying Buzz or copying runtime databases to the desktop.

## Source

The deployed Python exporter opens
`/home/mos-agent/.local/share/opencode/opencode.db` in SQLite read-only mode.
Its root-owned configuration binds it to:

- agent `mos-agent`
- pubkey `e802d359…07fdd00`
- channel `mos-boston` (`1da2b83b-c1e5-44b3-8a1c-546bf665933e`)

The latest user message containing the exact channel UUID identifies the turn.
The database belongs to the dedicated mos-agent account, while the fixed
configuration supplies the agent identity; callers cannot select another
database, agent, or channel.

## Transport

The Tauri native layer runs one fixed command on the fixed Doha Tailscale IP:

```text
/usr/bin/ssh root@100.119.77.122 \
  /usr/local/bin/control-tower-opencode-export <fixed identifiers>
```

Batch mode and bounded connection/keepalive settings prevent credential prompts
inside the app. The existing operating-system Tailscale SSH identity performs
authentication. No VM password, SSH private key, bearer token, or Buzz private
key is stored by Control Tower. There is no new listener or background service,
and mos-agent is not restarted.

## Exported semantics

- turn start, request receipt, working, and completion state
- OpenAI reasoning summaries that OpenCode stores separately from encrypted
  reasoning content
- tool type, title, status, allowlisted inputs, and bounded result
- shell command and working directory
- changed paths from patches, without patch bodies
- assistant progress and final messages
- runtime/trigger provenance fingerprints

The source caps the page at 200 activity events and 2 MiB on the client. The
native client verifies the expected channel, agent name, and pubkey, enforces
collection bounds, and applies credential redaction again.

## Withheld at source

- raw user messages, system/team instructions, and durable memory
- encrypted reasoning content and reasoning metadata
- token counts, costs, and rate-limit metadata
- patch bodies and file-read results
- database paths outside the configured workspace
- credential-shaped values and full 64-character hex strings

## Current scope

This milestone deliberately hard-codes the single approved Doha source. A later
multi-agent version needs owner-managed remote profiles and equivalent sidecars
on each host. Explicit signed evidence is still required before commit, push,
PR, merge, or deployment stages can be marked complete.
