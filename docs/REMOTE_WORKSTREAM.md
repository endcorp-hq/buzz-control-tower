# Remote workstream

Control Tower reads the MOS agent fleet through one fixed, companion-owned
collector on the Doha VM. Buzz is not modified, agent databases are never
copied to the desktop, and no runtime service is restarted.

## Fleet sources

The live collector accounts for every configured source on every poll:

| Agent | Source | State |
| --- | --- | --- |
| `mos-agent` | Doha `/home/mos-agent` | live |
| `lucas-mos-agent` | Doha `/home/lucas-agent` | live |
| `dany-mos-agent` | Doha `/home/dany-agent` | live |
| `Thor` | Thor `/home/thor-worker` | live through fixed nested SSH |
| `thor-mos-psc` | museum `/home/museum-bridge-worker` | live through fixed nested SSH |
| `vivid-bridge-mos-agent` | Windows/WSL continuity runtime | explicitly unavailable after Thor promotion |

Each source has a root-owned configuration that fixes its database, current
agent name, full Nostr pubkey, source label, and allowed channel. The complete
bounded source list is the authenticated runtime registry. Tower reconciles it
at launch and on every five-second refresh, so a registered addition, removal,
rename, or identity replacement no longer requires a desktop rebuild. A source
failure becomes an unavailable agent card; it cannot erase healthy pages.

## Desktop transport

The Tauri native layer executes only:

```text
ssh control-tower@mos-agent.tailc8418d.ts.net \
  /usr/local/bin/control-tower-fleet-export
```

The FQDN works for owner and externally shared Tailscale clients. Batch mode,
accept-new host-key handling, bounded connection/keepalive settings, a 15-second
deadline, and a 10 MiB response cap prevent interactive or unbounded behavior.
No VM password, private SSH key, bearer token, or Buzz private key is stored by
Control Tower.

The `control-tower` Linux account has a root-owned login shell that accepts only
the exact exporter command. Its only sudo capability is the no-argument,
root-owned fleet exporter. Interactive shells, alternate commands, arguments,
and file reads are rejected. Tailscale SSH policy maps only the approved Lucas
and Dany external identities to that account.

## Collector transport

The Doha collector runs all six configured sources concurrently:

- the three local databases are opened directly in SQLite read-only mode;
- Thor and museum exporters are invoked through fixed host/user/command arrays
  using mos-agent's existing production SSH identity;
- the retired continuity source has no command and produces a fixed unavailable
  record.

Each child page is bounded to 2 MiB. The collector verifies the exact returned
identity and source label against its root-owned registry. The Rust client
accepts at most 16 sources, requires the fixed MOS channel, rejects invalid or
duplicate identities, reapplies redaction, and rejects schema bounds before
anything reaches React. Relay delivery queries use the reconciled registry
pubkeys rather than a compiled desktop list.

## Exported semantics

- turn start, request receipt, working, and completion state
- OpenCode reasoning summaries stored separately from encrypted reasoning
- tool type, title, status, allowlisted inputs, and bounded result
- shell command and working directory
- changed paths from patches, without patch bodies
- assistant progress and final messages
- the isolated, bounded, credential-redacted human-authored Buzz request
- safe workspace/model/runtime-version/source fields
- runtime/trigger provenance fingerprints plus explicit visibility boundaries
- signed Buzz delivery messages from the matching agent only

## Withheld at source

- the raw combined user prompt, system/team instructions, durable memory,
  canvas body, and surrounding thread envelope
- encrypted reasoning content and reasoning metadata
- token counts, costs, and rate-limit metadata
- patch bodies and file-read results
- arbitrary database paths or caller-selected hosts/commands
- credential-shaped values and full 64-character hex strings

## Tailscale sharing

Doha is already shared to and accepted by `dany@vividstudio.me`. Device sharing
lets that external user reach only the shared node while staying on their own
tailnet; the owning tailnet's access policy still controls the connection. See
the current Tailscale documentation on [machine sharing](https://tailscale.com/kb/1084/sharing)
and [sharing access controls](https://tailscale.com/docs/features/sharing#sharing-and-access-control-policies).

The reverse share visible for Dany's `desktop-vfmf3b6` is intentionally
directional: it lets nilor reach that machine but does not grant that machine
access to nilor nodes. The already-accepted Doha share supplies the opposite
direction required by Control Tower.
