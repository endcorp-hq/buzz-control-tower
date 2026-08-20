import { describe, expect, it } from "vitest";
import {
  relaySnapshot,
  runtimePagesSnapshot,
  runtimeSnapshot,
  type RelayActivityPage,
  type RuntimeWorkstreamPage,
} from "./dataSource";

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

describe("companion runtime snapshot", () => {
  it("prioritizes a real redacted runtime and attaches signed delivery evidence", () => {
    const runtime: RuntimeWorkstreamPage = {
      channelId: "0b7c0958-3f7f-48c8-af3f-31e549b10e31",
      agentPubkey: "19215c80f8a71880f8c5738410d041e8afb2093bde1df8b4b691f23a50cb8b13",
      agentName: "Lucas-Fizz",
      sessionId: "session-1",
      turnId: "turn-1",
      status: "working",
      startedAt: "2027-01-15T08:00:00Z",
      model: "gpt-test",
      workspace: ".buzz",
      activity: [
        {
          id: "tool-1",
          at: "2027-01-15T08:00:01Z",
          kind: "tool",
          title: "Shell command",
          detail: "Arguments withheld by the source redactor.",
          status: "running",
          parameters: [
            { label: "Command", value: "cargo test" },
          ],
        },
      ],
      context: [
        {
          id: "context-1",
          kind: "thread",
          label: "Triggering Buzz turn",
          detail: "Content withheld.",
          hash: "abcdef123456",
          size: "2.1 KiB",
          visibility: "summary",
          content: "Make context inspectable.",
          fields: [{ label: "Channel", value: "buzz-control-tower" }],
        },
      ],
      evidence: [
        {
          stage: "local",
          label: "Runtime observed",
          detail: "Source-redacted local execution.",
          complete: true,
        },
      ],
      artifacts: [],
    };
    const relay: RelayActivityPage = {
      relayUrl: "wss://buzz.nilor.cool",
      channelId: runtime.channelId,
      devicePubkey: "a".repeat(64),
      messages: [
        {
          id: "b".repeat(64),
          pubkey: runtime.agentPubkey,
          kind: 9,
          createdAt: 1_800_000_002,
          content: "Public delivery",
        },
      ],
    };

    const snapshot = runtimeSnapshot(runtime, relay);
    const agent = snapshot.channels[0].workstreams[0].agents[0];

    expect(snapshot.source).toBe("runtime");
    expect(agent.status).toBe("working");
    expect(agent.model).toBe("gpt-test");
    expect(agent.activity.some((event) => event.title === "Shell command")).toBe(true);
    expect(agent.activity.find((event) => event.title === "Shell command")?.parameters).toEqual([
      { label: "Command", value: "cargo test" },
    ]);
    expect(agent.activity.some((event) => event.title === "Delivered to Buzz")).toBe(true);
    expect(agent.context).toHaveLength(1);
    expect(agent.context[0].content).toBe("Make context inspectable.");
    expect(agent.context[0].fields?.[0].value).toBe("buzz-control-tower");
    expect(agent.evidence[0].label).toBe("Runtime observed");
  });

  it("groups local and remote agents into their channel work graphs", () => {
    const base: RuntimeWorkstreamPage = {
      channelId: "0b7c0958-3f7f-48c8-af3f-31e549b10e31",
      agentPubkey: "1".repeat(64),
      agentName: "Local agent",
      sessionId: "local-session",
      turnId: "local-turn",
      status: "complete",
      startedAt: "2027-01-15T08:00:00Z",
      completedAt: "2027-01-15T08:00:01Z",
      model: "local-model",
      workspace: "local",
      activity: [],
      context: [],
      evidence: [],
      artifacts: [],
    };
    const remote = {
      ...base,
      channelId: "1da2b83b-c1e5-44b3-8a1c-546bf665933e",
      agentPubkey: "2".repeat(64),
      agentName: "mos-agent",
      sourceLabel: "Doha · mos-agent",
      sessionId: "remote-session",
      turnId: "remote-turn",
      workspace: "mos-agent",
    };

    const snapshot = runtimePagesSnapshot([
      { page: remote, origin: "remote" },
      { page: base, origin: "local" },
    ]);

    expect(snapshot.channels.map((channel) => channel.name)).toEqual(["mos-boston", "buzz-control-tower"]);
    expect(snapshot.channels[0].workstreams[0].agents[0].role).toContain("Doha");
    expect(snapshot.channels[1].workstreams[0].agents[0].role).toBe("Local agent runtime");
  });

  it("keeps configured but unavailable fleet agents visible", () => {
    const snapshot = runtimePagesSnapshot([], [{
      agentPubkey: "3".repeat(64),
      agentName: "vivid-bridge-mos-agent",
      sourceLabel: "Vivid studio · continuity bridge",
      detail: "Continuity runtime is stopped.",
    }]);

    const agent = snapshot.channels[0].workstreams[0].agents[0];
    expect(agent.agentName).toBe("vivid-bridge-mos-agent");
    expect(agent.status).toBe("idle");
    expect(agent.statusLabel).toBe("Unavailable");
    expect(agent.operation).toContain("stopped");
  });
});
