import { Copy, Info } from "lucide-react";
import { useState } from "react";
import { buildAuthorizeRequest, relayHostName } from "./authorizeRequest";

/**
 * The handholding half of the authorize step: what "authorize" actually
 * means, who can do it, where to post, plus a paste-ready request with its
 * own copy button. Shared by first-run onboarding, the add-workspace
 * overlay, and the setup-required screen so the story is identical
 * wherever a relay refuses the device key.
 */
export function AuthorizeHelp({
  relayUrl,
  devicePubkey,
  channels,
}: {
  relayUrl: string;
  devicePubkey?: string;
  channels?: string[];
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const host = relayHostName(relayUrl);
  const request = devicePubkey ? buildAuthorizeRequest({ relayUrl, devicePubkey, channels }) : undefined;

  const copyRequest = async () => {
    if (!request) return;
    try {
      await navigator.clipboard.writeText(request);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1_500);
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="authorize-help">
      <details className="status-legend authorize-help-details">
        <summary><Info size={13} /> What does authorize mean, and who can do it?</summary>
        <ul>
          <li>
            <span><strong>What happens.</strong> Someone with shell access on the <code>{host}</code> host
            admits this key as a relay member, then adds it to the channels you want to observe.
            Both are one-line, existing Buzz admin commands; nothing is installed or changed on your side.</span>
          </li>
          <li>
            <span><strong>Who can do it.</strong> The relay's operator, or an agent that runs on the relay host
            (its ops agent, typically). No special Buzz role is involved: the agent needs shell on that host,
            and your own account needs nothing.</span>
          </li>
          <li>
            <span><strong>Where to post.</strong> Any channel on <code>{host}</code> the operator or their agent
            reads; the relay's ops channel is ideal. The key is public, so posting it is safe anywhere.</span>
          </li>
          <li>
            <span><strong>Live tool calls are a separate, per-agent grant.</strong> The green Working lane
            lights up only for agents whose operator lists this key in <code>BUZZ_ACP_OBSERVER_READERS</code>{" "}
            on the agent's host. Presence, messages, and roster work without it.</span>
          </li>
          <li>
            <span><strong>What it can never do.</strong> Post, react, DM, or read anything it hasn't been added to.
            De-admitting it revokes access instantly.</span>
          </li>
        </ul>
      </details>
      {request && (
        <div className="authorize-request">
          <p className="onboarding-note">Tag your relay operator or their agent with this:</p>
          <pre>{request}</pre>
          <button type="button" className="authorize-request-copy" onClick={() => void copyRequest()}>
            <Copy size={13} /> {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy request message"}
          </button>
        </div>
      )}
    </div>
  );
}
