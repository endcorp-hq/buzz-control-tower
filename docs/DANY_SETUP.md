# Dany setup

Dany can build and run Control Tower 0.3.0 on `desktop-vfmf3b6` without
joining the nilor tailnet or switching away from `dany@vividstudio.me`.

## Network state already prepared

- `mos-agent.tailc8418d.ts.net` is shared to `dany@vividstudio.me`; the share
  was accepted on 2026-08-09.
- The nilor policy permits Dany's external identity to use only the dedicated
  `control-tower` Tailscale SSH login for the collector workflow.
- That Linux account rejects shells and every remote command except
  `/usr/local/bin/control-tower-fleet-export`.

Do not use a nilor auth key on Dany's Windows machine. An auth key would enroll
or switch the machine into nilor; it is unnecessary for this shared-node path.

Before building, confirm that Tailscale is signed in as
`dany@vividstudio.me`, then run this in PowerShell:

```powershell
tailscale status
tailscale ping mos-agent.tailc8418d.ts.net
ssh control-tower@mos-agent.tailc8418d.ts.net /usr/local/bin/control-tower-fleet-export `
  > "$env:TEMP\control-tower-fleet.json"
(Get-Content -Raw "$env:TEMP\control-tower-fleet.json" | ConvertFrom-Json).pages.agentName
```

The first SSH connection may ask Dany to confirm the host key or complete a
Tailscale SSH browser check. It must not offer an interactive Linux shell.

## Native Windows build and run

Install these prerequisites:

- Node.js 20 or newer, with Corepack
- Rust stable through `rustup`
- Git for Windows
- Microsoft C++ Build Tools with **Desktop development with C++**
- Microsoft Edge WebView2 Runtime
- Windows OpenSSH Client
- Tailscale
- Buzz Desktop, so authenticated access to the Buzz-hosted Git repository is
  available

Then use PowerShell:

```powershell
git clone https://buzz.nilor.cool/git/19215c80f8a71880f8c5738410d041e8afb2093bde1df8b4b691f23a50cb8b13/buzz-control-tower
Set-Location buzz-control-tower
git switch main
git pull --ff-only

corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm tauri dev
```

`tauri dev` is the quickest acceptance path. After testing, close the dev app
and build an installable package:

```powershell
corepack pnpm tauri build
```

Install the generated `.msi` or setup `.exe` under
`src-tauri\target\release\bundle`. The app invokes `ssh.exe` through `PATH`;
it never asks for or stores a Tailscale credential, VM password, agent Buzz
key, or personal Buzz key.

## First launch and device authorization

1. Windows may ask once for access to the OS credential vault used for the
   device-only Control Tower key.
2. The MOS runtime fleet should load through the already-shared Doha node even
   before relay delivery evidence is authorized.
3. If the badge says `Authorize device`, use **Copy device key** and post that
   public key in `#buzz-control-tower`. The channel owner can admit that
   device identity to the relay and relevant channels. The companion never
   needs Dany's permanent Buzz private key.

## How Dany's agents appear

`dany-mos-agent` is already registered in the root-owned Doha fleet registry.
Every Tower installation reconciles that complete bounded registry on launch
and every five-second refresh, so Dany does not add the existing MOS agents one
at a time on Windows.

For another remote agent, post its display name, full public key, source
machine, runtime home or database location, and Buzz channel. An operator must
register one fixed exporter source in the collector; after that, all Tower
clients discover additions, removals, renames, and identity replacements
without an app rebuild. Never post an agent private key or provider credential.

Since 0.3.0, every relay, channel, author, and collector binding lives in the
runtime workspace profile at `%USERPROFILE%\.config\control-tower\workspace.json`,
edited with `corepack pnpm tower <command>` — see `docs/ONBOARDING.md`. The
first launch writes the current nilor workspace automatically, so the MOS
fleet works with no extra step. Control Tower still does not auto-discover
arbitrary personal agents running locally on Dany's Windows machine; a local
runtime is followed only when the profile's `localRuntime` names it, and
multi-workspace switching remains future work.

## Acceptance test

- The roster includes `mos-agent`, `lucas-mos-agent`, `dany-mos-agent`, `Thor`,
  `thor-mos-psc`, and `vivid-bridge-mos-agent`.
- Healthy sources show real activity. Offline or retired sources remain visible
  as unavailable instead of disappearing.
- Expanding a tool row shows redacted parameters and results.
- **Context** cards open an inspectable detail drawer.
- Attempting any SSH command other than the fleet exporter is denied.
- A new signed MOS delivery appears only after the companion device key is
  admitted to Buzz and the channel.
