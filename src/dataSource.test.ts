import { describe, expect, it } from "vitest";
import { relaySnapshot, type RelayActivityPage } from "./dataSource";

describe("companion relay snapshot", () => {
  it("maps signed public messages without inventing private turn data", () => {
    const page: RelayActivityPage = {
      relayUrl: "wss://buzz.nilor.cool",
      channelId: "0b7c0958-3f7f-48c8-af3f-31e549b10e31",
      devicePubkey: "a".repeat(64),
      messages: [
        {
          id: "b".repeat(64),
          pubkey: "19215c80f8a71880f8c5738410d041e8afb2093bde1df8b4b691f23a50cb8b13",
          kind: 9,
          createdAt: 1_800_000_000,
          content: "Companion-only update",
          replyTo: "c".repeat(64),
        },
      ],
    };

    const snapshot = relaySnapshot(page);
    const agent = snapshot.channels[0].workstreams[0].agents[0];

    expect(snapshot.source).toBe("relay");
    expect(agent.activity[0].detail).toBe("Companion-only update");
    expect(agent.activity[0].title).toBe("Thread update posted");
    expect(agent.model).toBe("Not exposed");
    expect(agent.context).toEqual([]);
    expect(agent.evidence).toEqual([]);
    expect(agent.artifacts).toEqual([]);
  });
});
