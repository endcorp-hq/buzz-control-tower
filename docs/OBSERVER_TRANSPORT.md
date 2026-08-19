# Observer transport contract

Control Tower uses a device-scoped Nostr identity for observer access. Its
secret key is generated in Rust, stored in the operating-system keyring, and
never returned to JavaScript. It is not the user's permanent Buzz identity.

## Accepted frame shape

The Rust ingress accepts only a kind `24200` event that passes all of these
checks before its payload reaches the UI:

1. The Nostr event ID and Schnorr signature verify.
2. Exactly one `p`, `agent`, and `frame` tag exists.
3. `frame` is `telemetry`.
4. The event author equals the `agent` tag.
5. The `p` recipient equals this installation's device public key.
6. The selected agent and channel match when the caller supplies them.
7. The content fits the NIP-44 v2 ciphertext envelope.
8. NIP-44 decryption succeeds and the plaintext stays below 65,535 bytes.

The decrypted payload matches Buzz's existing camel-case `ObserverEvent`
schema. Plaintext is zeroized after deserialization.

## Required Buzz-side grant work

Existing Buzz observer frames are encrypted directly to the owner's permanent
identity and the relay allows subscriptions only when `#p` equals the
authenticated reader. Control Tower deliberately cannot consume those frames:
copying the permanent key into a companion would violate the product's security
boundary.

The live integration therefore requires an owner-signed, revocable observer
grant that binds:

- viewer device pubkey;
- agent pubkey;
- optional channel and thread scope;
- visibility tier;
- expiry and grant ID.

The relay must admit only the granted observer subscription, and the agent
harness must encrypt a redacted semantic frame separately to each active
viewer device. Revocation stops future frames; it does not claim to erase
already-decrypted local state.

Until that Buzz-side contract lands, the application labels its activity as a
fixture stream and reports the device as `observer grant pending`.
