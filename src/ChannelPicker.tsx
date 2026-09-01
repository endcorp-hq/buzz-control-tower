import { Copy, Plus, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import {
  addWorkspaceChannel,
  discoverChannelSummary,
  listRelayChannels,
  type ChannelSummary,
} from "./dataSource";

/** Channels the relay lists for this device that are not yet in the profile. */
export function selectableChannels(
  listed: ChannelSummary[],
  configuredChannelIds: string[],
): ChannelSummary[] {
  const configured = new Set(configuredChannelIds);
  return listed.filter((channel) => !configured.has(channel.id));
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The + affordance on the sidebar channel tree: list the channels this device
 * can access on the configured relay, minus the ones already observed, and add
 * the chosen one to the workspace profile. A paste-a-UUID row covers channels
 * that hide their directory from this device, mirroring onboarding. All writes
 * go through the bounded native `add_workspace_channel` command.
 */
export function ChannelPicker({
  relayUrl,
  configuredChannelIds,
  devicePubkey,
  onChanged,
}: {
  relayUrl: string;
  configuredChannelIds: string[];
  devicePubkey?: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listed, setListed] = useState<ChannelSummary[]>([]);
  const [error, setError] = useState<string>();
  const [manualChannelId, setManualChannelId] = useState("");
  const [keyCopied, setKeyCopied] = useState(false);

  const copyDeviceKey = async () => {
    if (!devicePubkey) return;
    try {
      await navigator.clipboard.writeText(devicePubkey);
      setKeyCopied(true);
    } catch {
      // Clipboard denied; the key stays visible in the security footer.
    }
  };

  const loadChannels = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setListed(await listRelayChannels(relayUrl));
    } catch (cause) {
      setListed([]);
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    setError(undefined);
    if (next) void loadChannels();
  };

  const add = async (channel: ChannelSummary) => {
    setBusy(true);
    setError(undefined);
    try {
      await addWorkspaceChannel(channel);
      setOpen(false);
      setManualChannelId("");
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const addManualChannel = async () => {
    const id = manualChannelId.trim();
    if (!id) return;
    let channel: ChannelSummary = { id, name: id.slice(0, 8), description: "" };
    try {
      const directory = await discoverChannelSummary(relayUrl, id);
      channel = { id, name: directory.name, description: directory.description };
    } catch {
      // The channel may hide its roster from this device; keep the id-derived
      // name and let the profile validation reject anything malformed.
    }
    await add(channel);
  };

  const candidates = selectableChannels(listed, configuredChannelIds);

  return (
    <>
      <button
        className={`sidebar-add${open ? " open" : ""}`}
        onClick={toggleOpen}
        aria-expanded={open}
        aria-label={open ? "Close channel picker" : "Add a channel"}
        title={open ? "Close" : "Add a channel"}
      >
        {open ? <X size={14} /> : <Plus size={14} />}
      </button>
      {open && (
        <div className="channel-picker" aria-label="Add a channel to this workspace">
          <div className="channel-picker-heading">
            <span>Channels on this relay</span>
            <button onClick={() => void loadChannels()} disabled={loading} aria-label="Reload channel list">
              <RefreshCw size={12} className={loading ? "picker-spin" : undefined} />
            </button>
          </div>
          {loading ? (
            <p className="channel-picker-note">Listing channels…</p>
          ) : candidates.length > 0 ? (
            <div className="channel-picker-list">
              {candidates.map((channel) => (
                <button key={channel.id} disabled={busy} onClick={() => void add(channel)}>
                  <span className="hash">#</span>
                  <span className="channel-picker-copy">
                    <strong>{channel.name}</strong>
                    {channel.description && <span>{channel.description}</span>}
                  </span>
                </button>
              ))}
            </div>
          ) : listed.length > 0 ? (
            <p className="channel-picker-note">
              Every channel this device can list is already observed.
            </p>
          ) : (
            <div className="channel-picker-empty">
              <p>
                The relay lists only channels where this <strong>device key</strong> is a
                member — channels you belong to as yourself, including new private
                channels, never appear on their own.
              </p>
              <p>
                Ask an operator or an agent in the channel to add the device key
                (<code>buzz channels add-member</code>), then reload.
              </p>
              {devicePubkey && (
                <button type="button" className="copy-device-key" onClick={() => void copyDeviceKey()}>
                  <Copy size={11} /> {keyCopied ? "Copied" : "Copy device key"}
                </button>
              )}
            </div>
          )}
          <form
            className="channel-picker-manual"
            onSubmit={(event) => {
              event.preventDefault();
              void addManualChannel();
            }}
          >
            <input
              value={manualChannelId}
              onChange={(event) => setManualChannelId(event.target.value)}
              placeholder="Or paste a channel UUID"
              aria-label="Channel UUID"
            />
            <button type="submit" disabled={busy || manualChannelId.trim().length === 0}>
              Add
            </button>
          </form>
          <p className="channel-picker-hint">
            A pasted channel streams only once this device key is a member of it too.
          </p>
          {error && <p className="channel-picker-error">{error}</p>}
        </div>
      )}
    </>
  );
}
