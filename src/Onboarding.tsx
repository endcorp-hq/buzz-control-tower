import { invoke, isTauri } from "@tauri-apps/api/core";
import { Hash, KeyRound, Radio, RefreshCw, Sparkles, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelDirectory, ChannelSummary } from "./dataSource";
import type { DeviceIdentityState } from "./deviceIdentity";

type OnboardingPhase = "relay" | "authorize" | "channels";

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
 * First-run journey: pick a relay, get the read-only device key admitted,
 * pick a channel. Everything it does is a deterministic native command —
 * `list_relay_channels`, `discover_channel_directory`, and a
 * `create_workspace_profile` that refuses to touch an existing profile.
 * Agents are never listed here because they are discovered live on every
 * refresh once the channel is chosen.
 */
export function Onboarding({
  deviceIdentity,
  onComplete,
}: {
  deviceIdentity: DeviceIdentityState;
  onComplete: () => void;
}) {
  const [phase, setPhase] = useState<OnboardingPhase>("relay");
  const [relayUrl, setRelayUrl] = useState("wss://");
  const [viewerName, setViewerName] = useState("");
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
      await invoke("create_workspace_profile", {
        relayUrl: activeRelay.current,
        workspace: relayHost(activeRelay.current),
        viewerName: viewerName.trim() || "Operator",
        channelId: channel.id,
        channelName: channel.name,
        channelDescription: channel.description,
      });
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
    <main className="onboarding-shell">
      <div className="onboarding-card">
        <div className="onboarding-brand">
          <div className="brand-mark"><Zap size={19} fill="currentColor" /></div>
          <div>
            <h1>Buzz Control Tower</h1>
            <p>Read-only observability for the agents in your Buzz channels.</p>
          </div>
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
              void connect(relayUrl.trim());
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
            <button type="submit" disabled={busy || !isTauri()}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </form>
        )}

        {phase === "authorize" && (
          <div className="onboarding-authorize">
            <p>
              <strong>{relayHost(activeRelay.current)}</strong> does not recognize this device yet.
              Send the read-only device key below to your relay operator; once it is admitted, this
              screen advances automatically.
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
          <Sparkles size={12} /> Later changes — more channels, fleet collectors, pinned authors —
          are plain commands: <code>corepack pnpm tower --help</code>.
        </p>
      </div>
    </main>
  );
}
