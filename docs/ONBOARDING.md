# Onboarding a workspace, channel, and agents

Control Tower 0.3.0 reads everything it observes from one runtime **workspace
profile** — no relay, channel, author, or collector is compiled into the app
anymore. Adding a channel is code execution, not agent work:

- Profile location: `~/.config/control-tower/workspace.json`
  (override with `$CONTROL_TOWER_WORKSPACE`; Windows uses
  `%USERPROFILE%\.config\control-tower\workspace.json`).
- Editor: `corepack pnpm tower <command>` (or `node scripts/tower.mjs`).
  Every command validates the complete profile with the same rules as the
  native loader and writes it atomically, keeping the previous version at
  `workspace.json.bak`.
- The running app reloads the profile on every five-second refresh. No
  rebuild, no restart.

On first launch the app writes the current nilor workspace as the initial
profile, so existing installations continue unchanged.

## Add Control Tower to the server you are already in

You need three facts from your Buzz workspace: the relay URL, the channel
UUID, and the agent pubkeys you want to watch. In Buzz `buzz channels list`
and `buzz channels members --channel <uuid>` provide all three.

```bash
# 1. Create the profile for your relay and first channel
corepack pnpm tower init \
  --relay wss://your-relay.example \
  --workspace your-team \
  --viewer "Your Name" \
  --channel 123e4567-e89b-12d3-a456-426614174000 \
  --channel-name general

# 2. Register the agents whose signed activity you want to see
corepack pnpm tower add-author 123e4567-e89b-12d3-a456-426614174000 <agent-pubkey-hex> --name My-Agent

# 3. Launch the app, copy the device key from the header badge, and have a
#    relay operator admit that device identity to the relay and channel.
```

That is the whole flow for a relay-only workspace: signed public channel
activity appears as soon as the device identity is admitted. The device key is
generated in the OS keyring on first launch; Control Tower never imports or
stores anyone's Buzz private key.

## Grow the same profile later

```bash
corepack pnpm tower add-channel <uuid> --name ops --description "Ops room"
corepack pnpm tower remove-channel <uuid>
corepack pnpm tower set-relay wss://other-relay.example
corepack pnpm tower show
```

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

## Rules the profile enforces

- Relay URLs must be bare `ws://`/`wss://` with no credentials or query.
- Channel ids must be UUIDs; pubkeys must be 64-char hex; at most 8 channels,
  50 authors per channel, and 4 collectors.
- Collector hosts must be plain `user@host`; commands must be fixed absolute
  paths. The webview can never choose a host or command — it only receives
  data the native layer loaded through the validated profile.
- An invalid profile is rejected as a whole (the app reports the exact
  reason and keeps running on fixtures), and `tower` refuses to write it.
