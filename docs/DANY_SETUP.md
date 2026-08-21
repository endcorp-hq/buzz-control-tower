# Dany setup

Dany can run Control Tower on `desktop-vfmf3b6` without joining the nilor
tailnet or switching away from `dany@vividstudio.me`.

## Network state already prepared

- `mos-agent.tailc8418d.ts.net` is shared to `dany@vividstudio.me`; the share
  was accepted on 2026-08-09.
- The nilor policy permits Dany's external identity to use only the dedicated
  `control-tower` Tailscale SSH login for the collector workflow.
- That Linux account rejects shells and every remote command except
  `/usr/local/bin/control-tower-fleet-export`.

Do not use a nilor auth key on Dany's Windows machine. An auth key would enroll
or switch the machine into nilor; it is unnecessary for this shared-node path.

## Native Windows build

Until signed Windows installers are published, build on the Windows host with:

1. Node.js 20+, Corepack, Rust stable, Microsoft C++ Build Tools, WebView2, Git,
   and Windows OpenSSH Client installed.
2. Clone the Buzz `buzz-control-tower` repository and check out the reviewed
   fleet commit.
3. Run:

   ```powershell
   corepack pnpm install --frozen-lockfile
   corepack pnpm check
   corepack pnpm tauri build
   ```

4. Install the generated Windows bundle from `src-tauri\target\release\bundle`.

The app invokes `ssh.exe` through `PATH`; it never asks for or stores a Tailscale
credential. The first connection may record Doha's SSH host key in the Windows
user's standard known-hosts file.

## First launch

1. Windows may ask once for access to the OS credential vault used for the
   device-only Control Tower key.
2. The MOS fleet timeline should load through the already-shared Doha node.
3. If the badge says `Authorize device`, use **Copy device key** and send that
   public key to the Buzz channel owner. Relay membership plus mos-boston channel
   membership are required only for attaching signed Buzz delivery messages;
   the SSH runtime workstreams do not contain a Buzz private key.

## Acceptance test

- `mos-agent`, `lucas-mos-agent`, `dany-mos-agent`, `Thor`, and
  `thor-mos-psc` appear with real activity.
- `vivid-bridge-mos-agent` appears as unavailable because the continuity runtime
  is intentionally stopped.
- Expanding a tool row shows redacted parameters/results.
- Attempting any SSH command other than the fleet exporter is denied.
- A new signed mos-boston delivery appears only after the companion device key
  is admitted to Buzz and the channel.
