import { invoke, isTauri } from "@tauri-apps/api/core";
import { Hash, KeyRound, Radio, RefreshCw, Sparkles, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { addWorkspace, type ChannelDirectory, type ChannelSummary } from "./dataSource";
import { AuthorizeHelp } from "./AuthorizeHelp";
import { importDeviceIdentity, type DeviceIdentityState } from "./deviceIdentity";

type OnboardingPhase = "relay" | "authorize" | "channels";
type IdentityMode = "own" | "device";

function relayHost(relayUrl: string) {
  try {
    return new URL(relayUrl).host || "workspace";
  } catch {
    return "workspace";
  }
}

function isAuthorizationError(message: string) {
  return message.includes("authorization required") || message.includes("not authorized");
}

/**
 * First-run journey: pick a relay and an identity, clear relay auth, pick a
 * channel. The default is a read-only device key (reused from the system
 * keychain when one exists) that an operator admits and authorizes — no
 * secret ever moves. Pasting an existing Buzz key stays as the escape hatch
 * for owners who have their nsec handy and want to skip the admission wait. Everything it does is a
 * deterministic native command — `import_device_identity`,
 * `list_relay_channels`, `discover_channel_directory`, and a
 * `create_workspace_profile` that refuses to touch an existing profile.
 * Agents are never listed here because they are discovered live on every
 * refresh once the channel is chosen.
 */
export function Onboarding({
  deviceIdentity,
  onIdentityChange,
  onComplete,
  mode = "create",
  onCancel,
}: {
  deviceIdentity: DeviceIdentityState;
  onIdentityChange: (state: DeviceIdentityState) => void;
  onComplete: () => void;
  /**
   * `create` = first run (writes the document, offers the paste-my-key escape
   * hatch). `add` = another relay on an existing install: same relay →
   * authorize → channel journey rendered as an overlay, ends in
   * `add_workspace`, and never touches the shared device identity.
   */
  mode?: "create" | "add";
  onCancel?: () => void;
}) {
  const adding = mode === "add";
  const [phase, setPhase] = useState<OnboardingPhase>("relay");
  const [relayUrl, setRelayUrl] = useState("wss://");
  const [viewerName, setViewerName] = useState("");
  const [identityMode, setIdentityMode] = useState<IdentityMode>("device");
  const [ownerSecret, setOwnerSecret] = useState("");
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [manualChannelId, setManualChannelId] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const activeRelay = useRef("");

  const connect = useCallback(async (target: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const listed = await invoke<ChannelSummary[]>("list_relay_channels", { relayUrl: target });
      activeRelay.current = target;
      setChannels(listed);
      setPhase("channels");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      activeRelay.current = target;
      if (isAuthorizationError(message)) {
        setPhase("authorize");
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  // While waiting for the operator to admit the device key, retry the same
  // read-only query every five seconds so admission is picked up hands-free.
  useEffect(() => {
    if (phase !== "authorize") return;
    const timer = window.setInterval(() => {
      if (activeRelay.current) void connect(activeRelay.current);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [phase, connect]);

  const finish = async (channel: ChannelSummary) => {
    setBusy(true);
    setError(undefined);
    try {
      if (adding) {
        await addWorkspace({
          relayUrl: activeRelay.current,
          workspace: relayHost(activeRelay.current),
          viewerName: viewerName.trim() || "Operator",
          channel,
        });
      } else {
        await invoke("create_workspace_profile", {
          relayUrl: activeRelay.current,
          workspace: relayHost(activeRelay.current),
          viewerName: viewerName.trim() || "Operator",
          channelId: channel.id,
          channelName: channel.name,
          channelDescription: channel.description,
        });
      }
      onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const addManualChannel = async () => {
    const id = manualChannelId.trim();
    if (!id) return;
    setBusy(true);
    setError(undefined);
    let channel: ChannelSummary = { id, name: id.slice(0, 8), description: "" };
    try {
      const directory = await invoke<ChannelDirectory>("discover_channel_directory", {
        relayUrl: activeRelay.current,
        channelId: id,
      });
      channel = { id, name: directory.name, description: directory.description };
    } catch {
      // The channel may hide its roster from this device; keep the id-derived
      // name and let the main screen surface any access error honestly.
    }
    await finish(channel);
  };

  // Import the pasted owner key, then land it in App state so the header and
  // security panel reflect the new identity immediately. Returns false (with
  // the error surfaced inline) instead of throwing so submit handlers can
  // simply stop.
  const importOwnerKey = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const identity = await importDeviceIdentity(ownerSecret.trim());
      onIdentityChange({ status: "ready", identity });
      setOwnerSecret("");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const copyDeviceKey = async () => {
    if (deviceIdentity.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(deviceIdentity.identity.pubkey);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1_500);
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <main className={`onboarding-shell${adding ? " onboarding-overlay" : ""}`} role={adding ? "dialog" : undefined} aria-modal={adding || undefined} aria-label={adding ? "Add a workspace" : undefined}>
      <div className="onboarding-card">
        <div className="onboarding-brand">
          <div className="brand-mark"><Zap size={19} fill="currentColor" /></div>
          <div>
            <h1>{adding ? "Add a workspace" : "Buzz Control Tower"}</h1>
            <p>
              {adding
                ? "Observe another relay. One relay per workspace; the Tower shows one at a time."
                : "Read-only observability for the agents in your Buzz channels."}
            </p>
          </div>
          {adding && onCancel && (
            <button type="button" className="onboarding-close" aria-label="Cancel adding a workspace" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>

        <ol className="onboarding-steps">
          <li className={phase === "relay" ? "active" : "done"}><Radio size={14} /> Select your relay</li>
          <li className={phase === "authorize" ? "active" : phase === "channels" ? "done" : ""}>
            <KeyRound size={14} /> Authorize this device
          </li>
          <li className={phase === "channels" ? "active" : ""}><Hash size={14} /> Select your channel</li>
        </ol>

        {!isTauri() && (
          <p className="onboarding-note">
            The browser preview cannot reach a relay. Launch the desktop app to complete onboarding.
          </p>
        )}

        {phase === "relay" && (
          <form
            className="onboarding-form"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                if (identityMode === "own" && !(await importOwnerKey())) return;
                await connect(relayUrl.trim());
              })();
            }}
          >
            <label>
              <span>Relay URL</span>
              <input
                value={relayUrl}
                onChange={(event) => setRelayUrl(event.target.value)}
                placeholder="wss://buzz.your-team.example"
                autoFocus
              />
            </label>
            <label>
              <span>Your name</span>
              <input
                value={viewerName}
                onChange={(event) => setViewerName(event.target.value)}
                placeholder="Shown in the header"
              />
            </label>
            {!adding && <div className="onboarding-identity">
              <span>Identity</span>
              <div className="onboarding-choice">
                <button
                  type="button"
                  className={identityMode === "device" ? "selected" : ""}
                  onClick={() => setIdentityMode("device")}
                >
                  Use a device key
                  <span>Recommended — no key pasting; an agent authorizes this device</span>
                </button>
                <button
                  type="button"
                  className={identityMode === "own" ? "selected" : ""}
                  onClick={() => setIdentityMode("own")}
                >
                  Paste my private key
                  <span>Escape hatch if you have your nsec handy — skips authorization</span>
                </button>
              </div>
              {identityMode === "own" && (
                <label>
                  <span>Private key</span>
                  <input
                    type="password"
                    value={ownerSecret}
                    onChange={(event) => setOwnerSecret(event.target.value)}
                    placeholder="nsec1… or 64-char hex"
                  />
                </label>
              )}
            </div>}
            {adding && (
              <p className="onboarding-note">
                This install's device key is reused. The new relay has to admit it before
                channels appear — the next step shows the key to hand your operator.
              </p>
            )}
            <button
              type="submit"
              disabled={busy || !isTauri() || (identityMode === "own" && !ownerSecret.trim())}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
            {identityMode === "own" && (
              <p className="onboarding-note">
                Your key is stored in the system keychain, never on disk in plaintext. Control
                Tower only signs relay auth with it — it never posts messages.
              </p>
            )}
          </form>
        )}

        {phase === "authorize" && (
          <div className="onboarding-authorize">
            <p>
              <strong>{relayHost(activeRelay.current)}</strong> does not recognize this device yet.
              Whoever runs that relay (its operator, or an agent on the relay host) needs to admit
              the read-only key below. Send them the ready-made request underneath; once the key is
              admitted, this screen advances automatically.
            </p>
            {deviceIdentity.status === "ready" ? (
              <code className="onboarding-key">{deviceIdentity.identity.pubkey}</code>
            ) : (
              <p className="onboarding-note">Preparing the device identity…</p>
            )}
            <div className="onboarding-actions">
              <button onClick={copyDeviceKey} disabled={deviceIdentity.status !== "ready"}>
                {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy device key"}
              </button>
              <button onClick={() => void connect(activeRelay.current)} disabled={busy}>
                <RefreshCw size={13} /> Check now
              </button>
              <button className="onboarding-secondary" onClick={() => setPhase("relay")}>
                Change relay
              </button>
            </div>
            <p className="onboarding-note">
              The key never signs messages — it only authenticates signed, read-only queries.
            </p>
            <AuthorizeHelp
              relayUrl={activeRelay.current}
              devicePubkey={deviceIdentity.status === "ready" ? deviceIdentity.identity.pubkey : undefined}
            />
            {!adding && (
              <>
                <form
                  className="onboarding-manual"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void (async () => {
                      if (await importOwnerKey()) await connect(activeRelay.current);
                    })();
                  }}
                >
                  <input
                    type="password"
                    value={ownerSecret}
                    onChange={(event) => setOwnerSecret(event.target.value)}
                    placeholder="Or paste your own key (nsec1… / hex)"
                  />
                  <button type="submit" disabled={busy || !ownerSecret.trim()}>
                    Use my key
                  </button>
                </form>
                <p className="onboarding-note">
                  Already a member of this relay? Pasting your own Buzz key replaces this install's
                  device key and skips the admission wait.
                </p>
              </>
            )}
          </div>
        )}

        {phase === "channels" && (
          <div className="onboarding-channels">
            <p>
              Choose the channel to observe on <strong>{relayHost(activeRelay.current)}</strong>.
              Agents are discovered from the channel roster automatically — there is nothing to
              register per agent.
            </p>
            {channels.length > 0 ? (
              <div className="onboarding-channel-list">
                {channels.map((channel) => (
                  <button key={channel.id} disabled={busy} onClick={() => void finish(channel)}>
                    <span className="hash">#</span>
                    <span className="onboarding-channel-copy">
                      <strong>{channel.name}</strong>
                      {channel.description && <span>{channel.description}</span>}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="onboarding-note">The relay listed no channels for this device.</p>
            )}
            <form
              className="onboarding-manual"
              onSubmit={(event) => {
                event.preventDefault();
                void addManualChannel();
              }}
            >
              <input
                value={manualChannelId}
                onChange={(event) => setManualChannelId(event.target.value)}
                placeholder="Or paste a channel UUID"
              />
              <button type="submit" disabled={busy || manualChannelId.trim().length === 0}>
                Use channel
              </button>
            </form>
            <button className="onboarding-secondary" onClick={() => setPhase("relay")}>
              Change relay
            </button>
          </div>
        )}

        {error && <p className="onboarding-error">{error}</p>}

        <p className="onboarding-foot">
          <Sparkles size={12} />{" "}
          {adding ? (
            "The new workspace becomes active as soon as its first channel is chosen; switch back any time from the header."
          ) : (
            <>
              Add more channels later with the + button on the work graph. Fleet collectors and
              pinned authors stay plain commands: <code>corepack pnpm tower --help</code>.
            </>
          )}
        </p>
      </div>
    </main>
  );
}
