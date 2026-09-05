/**
 * The paste-ready "please authorize my Tower" request. Everything the
 * relay operator (or their agent) needs is in the text: which relay, the
 * exact read-only key, the two admin commands, and what the key can never
 * do. Pure function so the copy is testable and identical on every screen
 * that shows the authorize step.
 */
export type AuthorizeRequestInput = {
  relayUrl: string;
  devicePubkey: string;
  /** Channel names the viewer wants observed; omitted = "the ones I name". */
  channels?: string[];
};

export function relayHostName(relayUrl: string): string {
  try {
    return new URL(relayUrl).host || relayUrl;
  } catch {
    return relayUrl.replace(/^wss?:\/\//, "") || "the relay";
  }
}

export function buildAuthorizeRequest({ relayUrl, devicePubkey, channels = [] }: AuthorizeRequestInput): string {
  const host = relayHostName(relayUrl);
  const named = channels.map((name) => name.trim()).filter(Boolean);
  const channelLine = named.length > 0
    ? `   Channels: ${named.map((name) => `#${name.replace(/^#/, "")}`).join(", ")}`
    : "   Channels: the ones I name in this thread";
  return [
    `Please authorize my Buzz Control Tower device on ${host}.`,
    "",
    `Device key (read-only observer; it signs queries, never messages): ${devicePubkey}`,
    "",
    "On the relay host, as whoever runs the relay:",
    `1. Admit it as a relay member: buzz-admin add-member --pubkey ${devicePubkey} --role member`,
    `2. Add it to each channel I should observe: buzz channels add-member --channel <channel-uuid> --pubkey ${devicePubkey} --role member`,
    channelLine,
    "3. Optional, for the live Working lane: list the key in BUZZ_ACP_OBSERVER_READERS on each agent's host and restart that agent.",
    "",
    "Nothing else changes: no role on my account, the key cannot post, and de-admitting it revokes access instantly. My Tower advances on its own once step 1 lands.",
  ].join("\n");
}
