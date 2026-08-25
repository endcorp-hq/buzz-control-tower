import { describe, expect, it } from "vitest";
import {
  channelAuthorPubkeys,
  fleetRosterPubkeys,
  mergeChannelRoster,
  observerStreamsByAgent,
  presentationFromProfile,
  relayPagesSnapshot,
  relaySnapshot,
  runtimePagesSnapshot,
  runtimeSnapshot,
  type AgentTelemetry,
  type ChannelDirectory,
  type RelayActivityPage,
  type ObserverStreamsPage,
  type RelayTelemetryPage,
  type RuntimeWorkstreamPage,
  type WorkspaceProfile,
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
  it("derives relay delivery authors from the collector roster", () => {
    expect(fleetRosterPubkeys({
      pages: [{ agentPubkey: "1".repeat(64) } as RuntimeWorkstreamPage],
      errors: [{
        agentPubkey: "2".repeat(64),
        agentName: "new-agent",
        sourceLabel: "New host",
        detail: "Starting up",
      }],
    })).toEqual(["1".repeat(64), "2".repeat(64)]);
  });

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

  it("presents channels and authors from a runtime workspace profile", () => {
    const profile: WorkspaceProfile = {
      version: 1,
      workspace: "example.org",
      viewerName: "Sam",
      relayUrl: "wss://buzz.example.org",
      channels: [
        {
          id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          name: "general",
          description: "Team room",
          authors: [{ pubkey: "4".repeat(64), name: "Sam-Agent" }],
        },
      ],
      collectors: [{
        label: "Example fleet",
        channelId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        sshHost: "control-tower@fleet.example.ts.net",
        command: "/usr/local/bin/control-tower-fleet-export",
      }],
    };
    const presentation = presentationFromProfile(profile);

    const snapshot = relaySnapshot({
      relayUrl: profile.relayUrl,
      channelId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      devicePubkey: "a".repeat(64),
      messages: [{
        id: "b".repeat(64),
        pubkey: "4".repeat(64),
        kind: 9,
        createdAt: 1_800_000_000,
        content: "Hello from a new workspace",
      }],
    }, presentation);

    expect(snapshot.workspaceName).toBe("example.org");
    expect(snapshot.relayUrl).toBe("wss://buzz.example.org");
    expect(snapshot.channels[0].name).toBe("general");
    expect(snapshot.channels[0].workstreams[0].agents[0].agentName).toBe("Sam-Agent");

    const unavailableSnapshot = runtimePagesSnapshot([], [{
      agentPubkey: "5".repeat(64),
      agentName: "fleet-agent",
      sourceLabel: "Example host",
      detail: "offline",
    }], presentation);
    expect(unavailableSnapshot.channels[0].id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(unavailableSnapshot.channels[0].name).toBe("general");
  });

  it("merges profile authors with the collector roster per channel", () => {
    const channel = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      name: "general",
      authors: [{ pubkey: "4".repeat(64), name: "Sam-Agent" }],
    };
    const authors = channelAuthorPubkeys(channel, {
      pages: [
        { agentPubkey: "1".repeat(64), channelId: channel.id } as RuntimeWorkstreamPage,
        { agentPubkey: "9".repeat(64), channelId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" } as RuntimeWorkstreamPage,
      ],
      errors: [{
        agentPubkey: "2".repeat(64),
        agentName: "offline-agent",
        sourceLabel: "Host",
        detail: "offline",
        channelId: channel.id,
      }],
    });
    expect(authors).toEqual(["4".repeat(64), "1".repeat(64), "2".repeat(64)]);
  });

  it("discovers channel agents from the relay roster with pins winning names", () => {
    const channel = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      name: "general",
      authors: [{ pubkey: "4".repeat(64), name: "Pinned-Name" }],
    };
    const directory: ChannelDirectory = {
      channelId: channel.id,
      name: "general",
      description: "",
      members: [
        { pubkey: "4".repeat(64), name: "Relay-Name", role: "owner", isAgent: true },
        { pubkey: "6".repeat(64), name: "thor-mos-psc", role: "bot", isAgent: true },
        { pubkey: "7".repeat(64), name: "Lucas", role: "admin", isAgent: false },
      ],
    };
    const roster = mergeChannelRoster(channel, directory, {
      pages: [{ agentPubkey: "8".repeat(64), channelId: channel.id } as RuntimeWorkstreamPage],
      errors: [],
    });

    expect(roster.authorPubkeys).toEqual([
      "4".repeat(64),
      "6".repeat(64),
      "7".repeat(64),
      "8".repeat(64),
    ]);
    expect(roster.authorNames.get("4".repeat(64))).toBe("Pinned-Name");
    expect(roster.authorNames.get("6".repeat(64))).toBe("thor-mos-psc");
    expect(roster.authorRoles.get("6".repeat(64))).toBe("Agent · channel roster");
    expect(roster.authorRoles.get("7".repeat(64))).toBe("Human participant");
  });

  it("falls back to configured pins when no roster is discoverable", () => {
    const channel = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      name: "general",
      authors: [{ pubkey: "4".repeat(64), name: "Pinned-Name" }],
    };
    const roster = mergeChannelRoster(channel, undefined, undefined);
    expect(roster.authorPubkeys).toEqual(["4".repeat(64)]);
    expect(roster.authorRoles.get("4".repeat(64))).toBe("Pinned author");
  });

  it("renders quiet roster members as idle cards in the relay snapshot", () => {
    const channelId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const page: RelayActivityPage = {
      relayUrl: "wss://buzz.example.org",
      channelId,
      devicePubkey: "a".repeat(64),
      messages: [{
        id: "b".repeat(64),
        pubkey: "4".repeat(64),
        kind: 9,
        createdAt: 1_800_000_000,
        content: "Recent speaker",
      }],
    };
    const rosters = new Map([[channelId, {
      authorPubkeys: ["4".repeat(64), "6".repeat(64)],
      authorNames: new Map([["6".repeat(64), "quiet-agent"]]),
      authorRoles: new Map(),
    }]]);

    const snapshot = relayPagesSnapshot([page], undefined, rosters);
    const agents = snapshot.channels[0].workstreams[0].agents;

    expect(agents.map((agent) => agent.pubkey)).toEqual(["4".repeat(64), "6".repeat(64)]);
    const quiet = agents[1];
    expect(quiet.statusLabel).toBe("Quiet");
    expect(quiet.operation).toContain("No signed channel events");
    expect(quiet.activity).toEqual([]);
  });

  it("adds quiet roster members as a channel-roster workstream in the runtime snapshot", () => {
    const channelId = "0b7c0958-3f7f-48c8-af3f-31e549b10e31";
    const runtime: RuntimeWorkstreamPage = {
      channelId,
      agentPubkey: "1".repeat(64),
      agentName: "live-agent",
      sessionId: "session-1",
      turnId: "turn-1",
      status: "working",
      startedAt: "2027-01-15T08:00:00Z",
      model: "gpt-test",
      workspace: ".buzz",
      activity: [],
      context: [],
      evidence: [],
      artifacts: [],
    };
    const rosters = new Map([[channelId, {
      authorPubkeys: ["1".repeat(64), "6".repeat(64)],
      authorNames: new Map([["6".repeat(64), "quiet-agent"]]),
      authorRoles: new Map(),
    }]]);
    const relayPages = new Map([[channelId, {
      relayUrl: "wss://buzz.example.org",
      channelId,
      devicePubkey: "a".repeat(64),
      messages: [{
        id: "b".repeat(64),
        pubkey: "6".repeat(64),
        kind: 9,
        createdAt: 1_800_000_000,
        content: "Older public update",
      }],
    }]]);

    const snapshot = runtimePagesSnapshot(
      [{ page: runtime, origin: "local" }], [], undefined, rosters, relayPages);
    const channel = snapshot.channels[0];
    const rosterStream = channel.workstreams.find((workstream) => workstream.title === "Channel roster");

    expect(rosterStream).toBeDefined();
    expect(rosterStream?.agents.map((agent) => agent.pubkey)).toEqual(["6".repeat(64)]);
    expect(rosterStream?.agents[0].statusLabel).toBe("Relay visible");
    expect(rosterStream?.agents[0].activity[0].detail).toBe("Older public update");
    expect(channel.workstreams.flatMap((w) => w.agents).filter(
      (agent) => agent.pubkey === "1".repeat(64))).toHaveLength(1);
  });

  it("labels discovered agents and humans in the relay snapshot", () => {
    const profile: WorkspaceProfile = {
      version: 1,
      workspace: "example.org",
      viewerName: "Sam",
      relayUrl: "wss://buzz.example.org",
      channels: [{ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "general", description: "" }],
    };
    const presentation = presentationFromProfile(profile);
    presentation.authorNames.set("6".repeat(64), "thor-mos-psc");
    presentation.authorRoles.set("6".repeat(64), "Agent · channel roster");

    const snapshot = relaySnapshot({
      relayUrl: profile.relayUrl,
      channelId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      devicePubkey: "a".repeat(64),
      messages: [{
        id: "b".repeat(64),
        pubkey: "6".repeat(64),
        kind: 9,
        createdAt: 1_800_000_000,
        content: "Discovered agent update",
      }],
    }, presentation);

    const agent = snapshot.channels[0].workstreams[0].agents[0];
    expect(agent.agentName).toBe("thor-mos-psc");
    expect(agent.role).toBe("Agent · channel roster");
  });

  it("enriches quiet roster cards with agent work-status telemetry", () => {
    const channelId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const page: RelayActivityPage = {
      relayUrl: "wss://buzz.example.org",
      channelId,
      devicePubkey: "a".repeat(64),
      messages: [{
        id: "b".repeat(64),
        pubkey: "6".repeat(64),
        kind: 9,
        createdAt: 1_800_000_000,
        content: "Older public update",
      }],
    };
    const rosters = new Map([[channelId, {
      authorPubkeys: ["6".repeat(64)],
      authorNames: new Map([["6".repeat(64), "busy-agent"]]),
      authorRoles: new Map(),
    }]]);
    const telemetry: AgentTelemetry = {
      pubkey: "6".repeat(64),
      eventCreatedAt: 1_800_000_010,
      status: "working",
      model: "opencode/gpt-5.6-sol",
      sessionId: "session-1",
      turnId: "turn-1",
      turnStartedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:10Z",
      activity: [
        { at: "2026-01-01T00:00:05Z", kind: "tool", title: "Shell command", status: "complete" },
        { at: "2026-01-01T00:00:08Z", kind: "message", title: "Streaming reply", status: "running" },
      ],
    };
    const telemetryPages = new Map<string, RelayTelemetryPage>([[channelId, {
      channelId,
      statuses: [telemetry],
    }]]);

    const snapshot = relayPagesSnapshot([page], undefined, rosters, telemetryPages);
    const agent = snapshot.channels[0].workstreams[0].agents[0];

    expect(agent.status).toBe("working");
    expect(agent.statusLabel).toBe("Working");
    expect(agent.model).toBe("opencode/gpt-5.6-sol");
    expect(agent.operation).toBe("Streaming reply");
    expect(agent.elapsed).not.toBe("—");
    // Telemetry activity (newest first) precedes the signed relay messages.
    expect(agent.activity.map((event) => event.title)).toEqual([
      "Streaming reply",
      "Shell command",
      "Channel update posted",
    ]);
    expect(agent.activity[0].status).toBe("running");
    expect(agent.activity[0].kind).toBe("message");
  });

  it("maps complete and error telemetry onto the card status union", () => {
    const channelId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const page: RelayActivityPage = {
      relayUrl: "wss://buzz.example.org",
      channelId,
      devicePubkey: "a".repeat(64),
      messages: [],
    };
    const rosters = new Map([[channelId, {
      authorPubkeys: ["6".repeat(64), "7".repeat(64)],
      authorNames: new Map<string, string>(),
      authorRoles: new Map<string, string>(),
    }]]);
    const telemetryPages = new Map<string, RelayTelemetryPage>([[channelId, {
      channelId,
      statuses: [
        {
          pubkey: "6".repeat(64),
          eventCreatedAt: 1_800_000_010,
          status: "complete",
          activity: [{ kind: "surprise-kind", title: "Wrap up", status: "unusual" }],
        },
        { pubkey: "7".repeat(64), eventCreatedAt: 1_800_000_011, status: "error", activity: [] },
      ],
    }]]);

    const snapshot = relayPagesSnapshot([page], undefined, rosters, telemetryPages);
    const [completeAgent, errorAgent] = snapshot.channels[0].workstreams[0].agents;

    expect(completeAgent.status).toBe("complete");
    expect(completeAgent.statusLabel).toBe("Turn complete");
    // Unknown activity kind/status values degrade to safe card values.
    expect(completeAgent.activity[0].kind).toBe("lifecycle");
    expect(completeAgent.activity[0].status).toBeUndefined();
    expect(errorAgent.status).toBe("blocked");
    expect(errorAgent.statusLabel).toBe("Turn error");
  });

  it("settles a stale completed turn back to idle instead of presenting it live", () => {
    const channelId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const page: RelayActivityPage = {
      relayUrl: "wss://buzz.example.org",
      channelId,
      devicePubkey: "a".repeat(64),
      messages: [],
    };
    const rosters = new Map([[channelId, {
      authorPubkeys: ["6".repeat(64)],
      authorNames: new Map<string, string>(),
      authorRoles: new Map<string, string>(),
    }]]);
    // A replaceable status event persists on the relay indefinitely; this one
    // finished long ago but still carries the harness's unclosed streaming entry.
    const telemetryPages = new Map<string, RelayTelemetryPage>([[channelId, {
      channelId,
      statuses: [{
        pubkey: "6".repeat(64),
        eventCreatedAt: 1_600_000_000,
        status: "complete",
        completedAt: "2020-09-13T12:26:40Z",
        activity: [
          { at: "2020-09-13T12:26:35Z", kind: "tool", title: "bash", status: "complete" },
          { at: "2020-09-13T12:26:39Z", kind: "message", title: "Streaming reply", status: "running" },
        ],
      }],
    }]]);

    const snapshot = relayPagesSnapshot([page], undefined, rosters, telemetryPages);
    const agent = snapshot.channels[0].workstreams[0].agents[0];

    expect(agent.status).toBe("idle");
    expect(agent.statusLabel).toBe("Idle");
    // The unclosed streaming entry settles: past-tense title, no running pulse.
    expect(agent.operation).toBe("Reply sent");
    expect(agent.activity[0].title).toBe("Reply sent");
    expect(agent.activity[0].status).toBe("complete");
    // Entries from a previous day carry their date, not a bare clock time.
    expect(agent.activity[0].at).toContain("Sep 13");
  });

  it("keeps runtime lanes authoritative over telemetry for the same agent", () => {
    const channelId = "0b7c0958-3f7f-48c8-af3f-31e549b10e31";
    const runtime: RuntimeWorkstreamPage = {
      channelId,
      agentPubkey: "1".repeat(64),
      agentName: "live-agent",
      sessionId: "session-1",
      turnId: "turn-1",
      status: "working",
      startedAt: "2027-01-15T08:00:00Z",
      model: "runtime-model",
      workspace: ".buzz",
      activity: [],
      context: [],
      evidence: [],
      artifacts: [],
    };
    const rosters = new Map([[channelId, {
      authorPubkeys: ["1".repeat(64), "6".repeat(64)],
      authorNames: new Map<string, string>(),
      authorRoles: new Map<string, string>(),
    }]]);
    const telemetryPages = new Map<string, RelayTelemetryPage>([[channelId, {
      channelId,
      statuses: [
        {
          pubkey: "1".repeat(64),
          eventCreatedAt: 1_800_000_010,
          status: "error",
          model: "telemetry-model",
          activity: [],
        },
        {
          pubkey: "6".repeat(64),
          eventCreatedAt: 1_800_000_011,
          status: "working",
          model: "quiet-agent-model",
          activity: [],
        },
      ],
    }]]);

    const snapshot = runtimePagesSnapshot(
      [{ page: runtime, origin: "local" }], [], undefined, rosters, undefined, telemetryPages);
    const agents = snapshot.channels[0].workstreams.flatMap((workstream) => workstream.agents);
    const runtimeCards = agents.filter((agent) => agent.pubkey === "1".repeat(64));
    const quietCard = agents.find((agent) => agent.pubkey === "6".repeat(64));

    // The SSH-collected runtime lane is not duplicated or overridden.
    expect(runtimeCards).toHaveLength(1);
    expect(runtimeCards[0].model).toBe("runtime-model");
    expect(runtimeCards[0].status).toBe("working");
    expect(runtimeCards[0].statusLabel).toBe("Working");
    // The quiet roster member still gets telemetry enrichment.
    expect(quietCard?.model).toBe("quiet-agent-model");
    expect(quietCard?.status).toBe("working");
  });

  it("caps prepended telemetry activity at twenty entries", () => {
    const channelId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const page: RelayActivityPage = {
      relayUrl: "wss://buzz.example.org",
      channelId,
      devicePubkey: "a".repeat(64),
      messages: [],
    };
    const rosters = new Map([[channelId, {
      authorPubkeys: ["6".repeat(64)],
      authorNames: new Map<string, string>(),
      authorRoles: new Map<string, string>(),
    }]]);
    const telemetryPages = new Map<string, RelayTelemetryPage>([[channelId, {
      channelId,
      statuses: [{
        pubkey: "6".repeat(64),
        eventCreatedAt: 1_800_000_010,
        status: "working",
        activity: Array.from({ length: 25 }, (_, index) => ({
          kind: "tool",
          title: `step-${index}`,
        })),
      }],
    }]]);

    const snapshot = relayPagesSnapshot([page], undefined, rosters, telemetryPages);
    const agent = snapshot.channels[0].workstreams[0].agents[0];

    expect(agent.activity).toHaveLength(20);
    // Newest-last input keeps the newest twenty, rendered newest first.
    expect(agent.activity[0].title).toBe("step-24");
    expect(agent.activity[19].title).toBe("step-5");
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

describe("companion rich lane", () => {
  const channelId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const agentPubkey = "6".repeat(64);
  const page: RelayActivityPage = {
    relayUrl: "wss://buzz.example.org",
    channelId,
    devicePubkey: "a".repeat(64),
    messages: [],
  };
  const rosters = new Map([[channelId, {
    authorPubkeys: [agentPubkey],
    authorNames: new Map<string, string>(),
    authorRoles: new Map<string, string>(),
  }]]);
  const telemetry: AgentTelemetry = {
    pubkey: agentPubkey,
    eventCreatedAt: 1_800_000_010,
    status: "working",
    model: "opencode/gpt-5.6-sol",
    turnStartedAt: "2026-01-01T00:00:00Z",
    activity: [
      { at: "2026-01-01T00:00:05Z", kind: "tool", title: "Shell command", status: "complete" },
    ],
  };
  const telemetryPages = new Map<string, RelayTelemetryPage>([[channelId, {
    channelId,
    statuses: [telemetry],
  }]]);
  const observerPage: ObserverStreamsPage = {
    relayUrl: "wss://buzz.example.org",
    connected: true,
    agents: [{
      agentPubkey,
      channelId,
      sessionId: "session-1",
      turnId: "turn-1",
      updatedAt: 1_800_000_020,
      liveText: "Deploying the fix now.",
      liveThought: "The test failure points at the cache.",
      entries: [
        {
          id: "call-9",
          at: "2026-01-01T00:00:07Z",
          kind: "tool",
          title: "Shell command",
          detail: "",
          status: "complete",
          parameters: [{ label: "command", value: "cargo test" }],
          result: "ok. 39 passed",
        },
        {
          id: "1-turn-started",
          at: "2026-01-01T00:00:01Z",
          kind: "lifecycle",
          title: "Turn started",
          detail: "Live encrypted agent stream.",
          status: "complete",
          parameters: [],
        },
      ],
    }],
  };

  it("supersedes telemetry activity with decrypted rich entries and carries the live text", () => {
    const observerStreams = observerStreamsByAgent(observerPage);
    const snapshot = relayPagesSnapshot(
      [page], undefined, rosters, telemetryPages, observerStreams);
    const agent = snapshot.channels[0].workstreams[0].agents[0];

    // Telemetry still owns status and model; the rich lane owns activity.
    expect(agent.status).toBe("working");
    expect(agent.model).toBe("opencode/gpt-5.6-sol");
    expect(agent.activity.map((event) => event.title)).toEqual([
      "Shell command",
      "Turn started",
    ]);
    expect(agent.activity[0].parameters).toEqual([
      { label: "command", value: "cargo test" },
    ]);
    expect(agent.activity[0].result).toBe("ok. 39 passed");
    expect(agent.liveText).toBe("Deploying the fix now.");
    expect(agent.liveThought).toBe("The test failure points at the cache.");
  });

  it("does not enrich a card in a different channel than the stream", () => {
    const otherChannel = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const otherPage: RelayActivityPage = { ...page, channelId: otherChannel };
    const otherRosters = new Map([[otherChannel, {
      authorPubkeys: [agentPubkey],
      authorNames: new Map<string, string>(),
      authorRoles: new Map<string, string>(),
    }]]);
    const observerStreams = observerStreamsByAgent(observerPage);
    const snapshot = relayPagesSnapshot(
      [otherPage], undefined, otherRosters, undefined, observerStreams);
    const agent = snapshot.channels[0].workstreams[0].agents[0];

    expect(agent.liveText).toBeUndefined();
    expect(agent.activity).toEqual([]);
  });

  it("indexes observer streams by agent pubkey", () => {
    const byAgent = observerStreamsByAgent(observerPage);
    expect(byAgent.get(agentPubkey)?.liveText).toBe("Deploying the fix now.");
    expect(observerStreamsByAgent(undefined).size).toBe(0);
  });
});
