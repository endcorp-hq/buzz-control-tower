# Onboarding: relay → device → channel → agents appear

Control Tower 0.4.0 never joins a workspace by itself. There is no compiled-in
relay and no default profile: on first launch the app opens an onboarding
screen, and everything it does behind that screen is a deterministic native
command — no agent judgment anywhere in the flow.

## The user journey

1. **Select your relay.** Enter the `wss://` relay URL of the Buzz server you
   are already in, plus your display name.
2. **Authorize this device.** The app shows its read-only device key (created
   in the OS keyring; it can never sign messages) together with a paste-ready
   request and a "what does authorize mean" explainer. Copy the request and
   tag whoever runs that relay — its operator, or an agent on the relay host
   (an ops agent, typically; no special Buzz role is needed, only shell on
   the host). The request names the relay, the key, and the two admin
   commands (`buzz-admin add-member`, then `buzz channels add-member` per
   channel). The screen polls the relay every five seconds and advances by
   itself the moment the key is admitted.
3. **Select your channel.** The app lists the channels the relay makes visible
   to the device (signed kind:39000 metadata). Pick one — or paste a channel
   UUID directly. The choice is written to the workspace profile through a
   native command that refuses to overwrite an existing profile.
4. **Agents appear on their own.** There is no per-agent registration step.
   On every five-second refresh the app discovers the channel roster from
   signed relay events and watches everyone the device is authorized to see.

## How agent discovery works (all code, no agent work)

Discovery is two signed, read-only NIP-98 queries against the relay's
`/query` endpoint — the same authenticated path used for channel activity:

| Data | Source event | What it provides |
|------|--------------|------------------|
| Member roster + roles | kind:39002 (`#d` = channel id) | every member pubkey with its role: `owner` / `admin` / `member` / `bot` |
| Agent registry | kind:10100 | relay-registered agent profiles, authored by the agent |
| Display names | kind:0 | `display_name` / `name` for every member |
| Channel metadata | kind:39000 (`#d` = channel id) | channel name and description |

A member is classified as an agent when its roster role is `bot` **or** it has
a kind:10100 agent profile. Members added, removed, or renamed later appear
automatically — the roster is re-discovered live (cached for 60 seconds), not
copied into config. Configured authors in the profile remain as optional
*pins*: their names win, they are never evicted by the 50-author cap, and they
keep working even if the relay hides the roster.

## Scripted onboarding (CLI, no UI)

Everything the onboarding screen does is also a plain command, so an agent or
script can onboard a workspace headlessly:

```bash
corepack pnpm tower init \
  --relay wss://your-relay.example \
  --workspace your-team \
  --viewer "Your Name" \
  --channel 123e4567-e89b-12d3-a456-426614174000 \
  --channel-name general
# Launch the app; have the operator admit the device key from the header
# badge. Agents are discovered automatically — no add-author needed.
```

- Document location: `~/.config/control-tower/workspace.json`
  (override with `$CONTROL_TOWER_WORKSPACE`; Windows uses
  `%USERPROFILE%\.config\control-tower\workspace.json`).
- The document lists **workspaces — one relay each — plus which one is
  active** (`{ "version": 2, "activeWorkspace": "...", "workspaces": [...] }`).
  The app observes one workspace at a time; every channel, author, collector,
  and local-runtime command below acts on the active one. Workspace ids are
  derived from the relay host (`wss://buzz.example.org` → `buzz-example-org`).
- Files written by releases up to v0.9.x hold a single bare profile
  (`"version": 1`). They load transparently as a one-workspace document and are
  rewritten in the new shape on the first mutation — no manual migration.
- Every `tower` command validates the complete document with the same rules as
  the native loader and writes it atomically, keeping the previous version at
  `workspace.json.bak`. The running app reloads it on every refresh — no
  rebuild, no restart.

## Grow the same profile later

```bash
corepack pnpm tower add-channel <uuid> --name ops --description "Ops room"
corepack pnpm tower add-author <uuid> <pubkey-hex> --name My-Agent   # optional pin
corepack pnpm tower remove-channel <uuid>
corepack pnpm tower set-relay wss://other-relay.example   # retarget the active workspace
corepack pnpm tower show
```

## Observe a second relay

Each relay is its own workspace. Adding one makes it active; the app's next
refresh retargets every relay read (roster, presence, telemetry, rich lane)
to it. The device key is the same everywhere, so the new relay has to admit it
and its channels have to list it before anything streams — the same
authorize ceremony as the first relay, once per relay.

```bash
corepack pnpm tower add-workspace \
  --relay wss://second-relay.example \
  --workspace second-team \
  --channel 123e4567-e89b-12d3-a456-426614174000 \
  --channel-name general
corepack pnpm tower workspaces                 # list ids, relays, which is active
corepack pnpm tower use buzz-example-org       # switch back
corepack pnpm tower remove-workspace second-relay-example
```

In the app the same journey lives under the workspace name in the header:
the switcher lists every workspace with its relay host and channel count,
switches with one click, and **Add a workspace** runs the relay → authorize →
channel flow as an overlay (the paste-my-key escape hatch is first-run only;
another relay always reuses this install's device key). Removing a workspace
has the same guard rails as removing a channel: the last one cannot be
removed, and removing the active one activates the first remaining.

## Add a runtime fleet collector (optional, deeper visibility)

Signed relay activity needs no infrastructure. Live execution streams
(tools, files, context) additionally need one **fleet collector** per source
machine: a root-owned exporter reachable over Tailscale SSH with a single
forced command (see `docs/REMOTE_WORKSTREAM.md` and `deploy/`).

```bash
corepack pnpm tower add-collector \
  --channel <uuid> \
  --label "My fleet" \
  --host control-tower@your-host.your-tailnet.ts.net \
  --command /usr/local/bin/control-tower-fleet-export
```

Registering an agent inside that collector remains a host-side operator step
(its database path and identity cannot be safely guessed); after that, every
Tower client discovers roster additions, removals, renames, and identity
replacements automatically.

## Watch a local agent runtime (optional)

```bash
corepack pnpm tower set-local --channel <uuid> --pubkey <hex> --name My-Agent
```

## Boundaries the flow enforces

- The in-app onboarding write (`create_workspace_profile`) only works while no
  profile exists. Retargeting an existing install — changing relay, adding
  channels — is an operator/CLI action, never a webview one.
- Relay URLs must be bare `ws://`/`wss://` with no credentials or query.
- Channel ids must be UUIDs; pubkeys must be 64-char hex; at most 8 channels,
  50 watched authors per channel, and 4 collectors.
- Collector hosts must be plain `user@host`; commands must be fixed absolute
  paths. The webview can never choose a host or command.
- Discovery only ever reads signature-verified events, and only what the
  relay authorizes the admitted device key to see.
- An invalid profile is rejected as a whole (the app reports the exact
  reason and keeps running on fixtures), and `tower` refuses to write it.
