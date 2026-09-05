import { Check, ChevronDown, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceSummary } from "./domain";

export function relayHostOf(relayUrl: string) {
  return relayUrl.replace(/^wss?:\/\//, "").replace(/\/+$/, "");
}

/**
 * The workspace selector in the header brand block. One workspace = one relay;
 * the Tower observes exactly one at a time. Switching, adding and removing all
 * go through bounded native commands owned by the parent; this component only
 * renders the list and reports intent.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  busy,
  onSwitch,
  onAdd,
  onRemove,
}: {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId?: string;
  busy?: boolean;
  onSwitch: (workspaceId: string) => void;
  onAdd: () => void;
  onRemove: (workspaceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!active) return null;
  const removable = workspaces.length > 1;

  return (
    <div className="workspace-switcher" ref={rootRef}>
      <button
        type="button"
        className="workspace-switcher-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch workspace"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="workspace-switcher-label">
          {active.workspace === relayHostOf(active.relayUrl)
            ? active.workspace
            : `${active.workspace} · ${relayHostOf(active.relayUrl)}`}
        </span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="workspace-switcher-menu" role="listbox" aria-label="Workspaces">
          {workspaces.map((workspace) => {
            const isActive = workspace.id === active.id;
            return (
              <div className={`workspace-row${isActive ? " active" : ""}`} key={workspace.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  disabled={busy}
                  onClick={() => {
                    setOpen(false);
                    if (!isActive) onSwitch(workspace.id);
                  }}
                >
                  <span className="workspace-row-check">{isActive && <Check size={12} />}</span>
                  <span className="workspace-row-copy">
                    <strong>{workspace.workspace}</strong>
                    <span>
                      {relayHostOf(workspace.relayUrl)} · {workspace.channelCount}{" "}
                      {workspace.channelCount === 1 ? "channel" : "channels"}
                    </span>
                  </span>
                </button>
                {removable && (
                  <button
                    type="button"
                    className="workspace-row-remove"
                    aria-label={`Stop observing ${workspace.workspace}`}
                    title="Remove this workspace"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      onRemove(workspace.id);
                    }}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="workspace-add"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
          >
            <Plus size={12} /> Add a workspace (another relay)
          </button>
          <p className="workspace-switcher-note">
            One relay per workspace. The device key is the same everywhere; each relay and
            channel has to admit it before anything streams.
          </p>
        </div>
      )}
    </div>
  );
}
