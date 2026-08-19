# Read-only relay activity contract

Control Tower uses its own device-scoped Nostr identity. The secret is generated
in Rust, stored in the operating-system keyring, and never returned to
JavaScript. It is not the user's permanent Buzz identity.

## Authorization

Buzz's existing membership controls remain authoritative. Before the companion
can read a channel, an administrator must admit the displayed device pubkey to
the relay and the channel. Until then the app reports `Authorize device` and
keeps the fixture fallback visible.

Control Tower does not create memberships, import the owner's key, or request a
new Buzz protocol.

The native process reads the keyring at most once per launch and caches either
the device key or the denial result. Authorization and network failures pause
automatic polling; the user must explicitly retry. This prevents repeated OS
credential prompts.

## Query boundary

The native adapter:

1. accepts only a `ws` or `wss` relay URL with no credentials or fragment;
2. converts it to the relay's existing HTTPS `/query` endpoint;
3. signs each request with a fresh NIP-98 event and nonce;
4. requests only standard channel message kinds for one channel and an explicit
   author allowlist;
5. verifies every returned event ID and Schnorr signature;
6. rejects wrong-channel, wrong-author, wrong-kind, duplicate-channel-tag, and
   oversized events before returning data to the UI.

## Honest scope

This adapter observes signed public channel updates. It does not expose or infer
private model prompts, supplied context, tool calls, hidden chain-of-thought,
ephemeral owner-encrypted observer frames, or deployment state. Those fields
remain empty or `Not exposed` in relay mode.
