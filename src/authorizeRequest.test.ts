import { describe, expect, it } from "vitest";
import { buildAuthorizeRequest, relayHostName } from "./authorizeRequest";

const key = "86a9bfdaf5324339293510ba2512c5c0912ac3a4ae4142be10cfce949a609552";

describe("buildAuthorizeRequest", () => {
  it("names the relay, the key, and both admin commands so any operator can act on it", () => {
    const text = buildAuthorizeRequest({ relayUrl: "wss://relay.example", devicePubkey: key, channels: ["general", "#ops"] });
    expect(text).toContain("device on relay.example.");
    expect(text).toContain(`buzz-admin add-member --pubkey ${key} --role member`);
    expect(text).toContain(`buzz channels add-member --channel <channel-uuid> --pubkey ${key} --role member`);
    expect(text).toContain("Channels: #general, #ops");
    expect(text).toContain("BUZZ_ACP_OBSERVER_READERS");
    expect(text).toContain("the key cannot post");
  });

  it("falls back to a placeholder channel line when no channels are known yet", () => {
    const text = buildAuthorizeRequest({ relayUrl: "wss://relay.example", devicePubkey: key });
    expect(text).toContain("Channels: the ones I name in this thread");
  });

  it("degrades to the raw relay string when the URL does not parse", () => {
    expect(relayHostName("wss://relay.example")).toBe("relay.example");
    expect(relayHostName("not a url")).toBe("not a url");
  });
});
