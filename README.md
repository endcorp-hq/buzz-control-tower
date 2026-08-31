<p align="center">
  <img src="assets/control-tower-aviator-cap-1024.png" width="220" alt="Buzz Control Tower — the aviator cap" />
</p>

<h1 align="center">Buzz Control Tower</h1>

<p align="center"><em>Goggles down. Every agent in your fleet, on one radar.</em></p>

<p align="center">
  <a href="https://github.com/endcorp-hq/buzz-control-tower/releases/latest"><img src="https://img.shields.io/github/v/release/endcorp-hq/buzz-control-tower?label=latest&color=b8860b" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-Tauri%202-2f6f4f" alt="macOS, Windows, Linux — Tauri 2" />
  <a href="https://github.com/endcorp-hq/buzz-control-tower/actions/workflows/release.yml"><img src="https://github.com/endcorp-hq/buzz-control-tower/actions/workflows/release.yml/badge.svg" alt="Release build" /></a>
</p>

---

Buzz Control Tower is the desktop companion for [Buzz](https://github.com/block/buzz) agent fleets: a
cockpit view of what every agent is doing **right now** — live activity, context
provenance, workstreams, and delivery evidence — without ever holding your Buzz
key or your agents' secrets.

You run agents. The Tower is where you watch them fly.

## ✈️ Boarding

Grab the installer for your platform from the
[latest release](https://github.com/endcorp-hq/buzz-control-tower/releases/latest)
— macOS (Apple silicon + Intel), Windows, and Linux.

Install once; the Tower checks the release feed on launch and **updates
itself**. Fixes just arrive.

## 🗼 What's on the radar

- **Fleet roster** — channel → workstream → agent navigation, one card per agent
- **Live lane** — streaming replies, reasoning summaries, and tool calls as they
  happen, decrypted from per-reader encrypted status events your agents publish
- **Context provenance** — interactive cards showing the isolated request, safe
  runtime fields, and source-integrity metadata, with explicit reasons for
  anything withheld at source
- **Delivery evidence** — ordinary signed Buzz messages attached through a
  read-only relay interface
- **One workspace profile** — every relay, channel, author, and collector
  binding lives in a single profile edited by the deterministic `tower` CLI
  (`docs/ONBOARDING.md`); adding a channel needs no rebuild

## 🔧 Flying it from source

Prerequisites: Node.js 20+, Corepack, and the Rust toolchain pinned in
`rust-toolchain.toml`.

```bash
corepack pnpm install
corepack pnpm tauri dev
```

`corepack pnpm check` runs the complete repository verification.

## 🛡️ The instrument panel (how data gets in)

The Tower is intentionally paranoid about what reaches the webview:

- Each source — local Codex runtime, forced-command SSH fleet collectors, or the
  relay's encrypted status stream — reduces its current turn into lifecycle,
  tool, file-change, provenance, and artifact events **before** raw runtime
  data can reach the UI.
- The exporter isolates a bounded, credential-redacted, human-authored Buzz
  request for the Context viewer. Raw prompt envelopes, private model
  reasoning, encrypted content, token counts, and rate limits are discarded.
- Base/system instructions, durable memory, canvas bodies, and full thread
  envelopes are fingerprinted, never copied.
- The Tower holds its own OS-keyring device identity. It **never copies the
  owner's Buzz key**.
- When local or fleet data is unavailable, the Tower falls back to signed
  public relay events. If a configured relay becomes temporarily unreachable,
  it keeps the last verified snapshot while retrying; after those retries are
  exhausted, it shows an explicit unavailable state with a manual refresh.
  Fixture data is limited to the browser development preview—it never stands
  in for disconnected production data.

## 📚 Flight manuals

| Manual | Covers |
|---|---|
| `docs/ARCHITECTURE.md` | Data and security boundaries |
| `docs/ONBOARDING.md` | Workspace profile + `tower` CLI |
| `docs/LOCAL_WORKSTREAM.md` | Local execution contract |
| `docs/REMOTE_WORKSTREAM.md` | Fleet execution contract |
| `docs/DANY_SETUP.md` | Shared-node Windows handoff |

---

<p align="center"><sub>Built alongside the Buzz platform. Separate from the Buzz desktop monorepo and installer — on purpose.</sub></p>
