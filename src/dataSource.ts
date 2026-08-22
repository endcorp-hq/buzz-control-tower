import { invoke, isTauri } from "@tauri-apps/api/core";
import { fixtureSnapshot } from "./fixtures";
import type {
  ActivityEvent,
  Artifact,
  ContextSource,
  Evidence,
  SnapshotLoadResult,
  TowerSnapshot,
} from "./domain";

export const MOS_AGENT_PUBKEY = "e802d3594a2b31b22f35c6a42a17e1749d62decaceef5abe96841512607fdd00";

export type WorkspaceAuthor = { pubkey: string; name?: string };

export type WorkspaceChannel = {
  id: string;
  name: string;
  description?: string;
  authors?: WorkspaceAuthor[];
};

export type WorkspaceCollector = {
  label: string;
  channelId: string;
  sshHost: string;
  command: string;
};

export type WorkspaceProfile = {
  version: number;
  workspace: string;
  viewerName: string;
  relayUrl: string;
  channels: WorkspaceChannel[];
  collectors?: WorkspaceCollector[];
  localRuntime?: { channelId: string; agentPubkey: string; agentName: string };
};

export type WorkspaceDocument = {
  profile: WorkspaceProfile;
  path: string;
  bootstrapped: boolean;
};

export type WorkspacePresentation = {
  workspaceName: string;
  viewerName: string;
  relayUrl?: string;
  channels: Map<string, { name: string; description: string }>;
  authorNames: Map<string, string>;
  fleetChannelId?: string;
};

export function presentationFromProfile(profile: WorkspaceProfile): WorkspacePresentation {
  const channels = new Map<string, { name: string; description: string }>();
  const authorNames = new Map<string, string>();
  for (const channel of profile.channels) {
    channels.set(channel.id, {
      name: channel.name,
      description: channel.description ?? "",
    });
    for (const author of channel.authors ?? []) {
      if (author.name) authorNames.set(author.pubkey, author.name);
    }
  }
  return {
    workspaceName: profile.workspace,
    viewerName: profile.viewerName,
    relayUrl: profile.relayUrl,
    channels,
    authorNames,
    fleetChannelId: profile.collectors?.[0]?.channelId,
  };
}

const DEFAULT_PROFILE: WorkspaceProfile = {
  version: 1,
  workspace: "nilor.cool",
  viewerName: "Lucas",
  relayUrl: "wss://buzz.nilor.cool",
  channels: [
    {
      id: "0b7c0958-3f7f-48c8-af3f-31e549b10e31",
      name: "buzz-control-tower",
      description: "Product development for the Buzz observability companion",
      authors: [
        {
          pubkey: "19215c80f8a71880f8c5738410d041e8afb2093bde1df8b4b691f23a50cb8b13",
          name: "Lucas-Fizz",
        },
      ],
    },
    {
      id: "1da2b83b-c1e5-44b3-8a1c-546bf665933e",
      name: "mos-boston",
      description: "MOS Boston product development and deployment",
    },
  ],
  collectors: [
    {
      label: "Doha MOS fleet",
      channelId: "1da2b83b-c1e5-44b3-8a1c-546bf665933e",
      sshHost: "control-tower@mos-agent.tailc8418d.ts.net",
      command: "/usr/local/bin/control-tower-fleet-export",
    },
  ],
};

export const DEFAULT_PRESENTATION = presentationFromProfile(DEFAULT_PROFILE);

function channelPresentation(presentation: WorkspacePresentation, channelId: string) {
  return (
    presentation.channels.get(channelId) ?? {
      name: channelId.slice(0, 8),
      description: `Channel ${channelId}`,
    }
  );
}

function authorName(presentation: WorkspacePresentation, pubkey: string) {
  return presentation.authorNames.get(pubkey) ?? `${pubkey.slice(0, 8)}…`;
}

export type RelayMessage = {
  id: string;
  pubkey: string;
  kind: number;
  createdAt: number;
  content: string;
  replyTo?: string;
};

export type RelayActivityPage = {
  relayUrl: string;
  channelId: string;
  devicePubkey: string;
  messages: RelayMessage[];
};

export type RuntimeActivity = {
  id: string;
  at: string;
  kind: ActivityEvent["kind"];
  title: string;
  detail: string;
  status: NonNullable<ActivityEvent["status"]>;
  parameters: Array<{ label: string; value: string }>;
  result?: string;
};

export type RuntimeWorkstreamPage = {
  channelId: string;
  agentPubkey: string;
  agentName: string;
  sourceLabel?: string;
  sessionId: string;
  turnId: string;
  status: "working" | "complete";
  startedAt: string;
  completedAt?: string;
  model: string;
  workspace: string;
  activity: RuntimeActivity[];
  context: ContextSource[];
  evidence: Evidence[];
  artifacts: Artifact[];
};

export type RemoteSourceError = {
  agentPubkey: string;
  agentName: string;
  sourceLabel: string;
  detail: string;
  channelId?: string;
};

export type CollectorError = { label: string; detail: string };

export type RemoteFleetDocument = {
  pages: RuntimeWorkstreamPage[];
  errors: RemoteSourceError[];
  collectorErrors?: CollectorError[];
};

export function fleetRosterPubkeys(document: RemoteFleetDocument): string[] {
  return [
    ...document.pages.map((page) => page.agentPubkey),
    ...document.errors.map((error) => error.agentPubkey),
  ];
}

export interface TowerDataSource {
  loadSnapshot(): Promise<SnapshotLoadResult>;
}

type RuntimeSource = {
  page: RuntimeWorkstreamPage;
  relayPage?: RelayActivityPage;
  origin: "local" | "remote";
};

function activityFromMessage(message: RelayMessage): ActivityEvent {
  const time = new Date(message.createdAt * 1000).toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const title = message.kind === 40_003
    ? "Channel message edited"
    : message.kind === 40_008
      ? "Diff shared to channel"
      : message.replyTo
        ? "Thread update posted"
        : "Channel update posted";

  return {
    id: message.id,
    at: time,
    kind: message.kind === 40_008 ? "evidence" : "message",
    title,
    detail: message.content,
    status: "complete",
  };
}

export function relayPagesSnapshot(
  pages: RelayActivityPage[],
  presentation: WorkspacePresentation = DEFAULT_PRESENTATION,
): TowerSnapshot {
  const channels: TowerSnapshot["channels"] = [];
  for (const page of pages) {
    const meta = channelPresentation(presentation, page.channelId);
    const byAuthor = new Map<string, RelayMessage[]>();
    for (const message of page.messages) {
      const existing = byAuthor.get(message.pubkey);
      if (existing) existing.push(message);
      else byAuthor.set(message.pubkey, [message]);
    }
    const agents = [...byAuthor.entries()].map(([pubkey, messages]) => {
      const newest = messages.at(-1);
      return {
        id: `${page.channelId}-${pubkey}`,
        pubkey,
        agentName: authorName(presentation, pubkey),
        role: "Channel participant",
        status: "idle" as const,
        statusLabel: "Relay visible",
        operation: "Showing signed public channel updates",
        elapsed: "—",
        lastActivity: newest
          ? new Date(newest.createdAt * 1000).toLocaleTimeString()
          : "No events",
        model: "Not exposed",
        branch: "Not exposed",
        head: "Not exposed",
        helperCount: 0,
        activity: [...messages].reverse().map(activityFromMessage),
        context: [],
        evidence: [],
        artifacts: [],
      };
    });
    channels.push({
      id: page.channelId,
      name: meta.name,
      description: meta.description,
      workstreams: [
        {
          id: `${page.channelId}-public-relay-activity`,
          title: "Signed channel activity",
          phase: "Companion-only",
          agents,
        },
      ],
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    viewerName: presentation.viewerName,
    workspaceName: presentation.workspaceName,
    relayUrl: presentation.relayUrl,
    source: "relay",
    channels,
  };
}

export function relaySnapshot(
  page: RelayActivityPage,
  presentation: WorkspacePresentation = DEFAULT_PRESENTATION,
): TowerSnapshot {
  return relayPagesSnapshot([page], presentation);
}

function clockTime(value: string | number) {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return date.toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function elapsedTime(startedAt: string, completedAt?: string) {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  const seconds = Math.floor((end - start) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function runtimeSnapshot(
  page: RuntimeWorkstreamPage,
  relayPage?: RelayActivityPage,
): TowerSnapshot {
  return runtimePagesSnapshot([{ page, relayPage, origin: "local" }]);
}

export function runtimePagesSnapshot(
  sources: RuntimeSource[],
  unavailable: RemoteSourceError[] = [],
  presentation: WorkspacePresentation = DEFAULT_PRESENTATION,
): TowerSnapshot {
  const channels = new Map<string, TowerSnapshot["channels"][number]>();
  const ensureChannel = (channelId: string) => {
    let channel = channels.get(channelId);
    if (!channel) {
      channel = {
        id: channelId,
        ...channelPresentation(presentation, channelId),
        workstreams: [
          {
            id: `${channelId}-live-execution`,
            title: "Live agent execution",
            phase: "Source-redacted",
            agents: [],
          },
        ],
      };
      channels.set(channelId, channel);
    }
    return channel;
  };

  for (const { page, relayPage, origin } of sources) {
    const runtimeEvents = page.activity.map((event) => ({
      timestamp: new Date(event.at).getTime(),
      event: { ...event, at: clockTime(event.at) } satisfies ActivityEvent,
    }));
    const startedAtSeconds = Math.floor(new Date(page.startedAt).getTime() / 1000);
    const deliveryEvents = (relayPage?.messages ?? [])
      .filter((message) => message.pubkey === page.agentPubkey && message.createdAt >= startedAtSeconds)
      .map((message) => ({
        timestamp: message.createdAt * 1000,
        event: {
          ...activityFromMessage(message),
          title: "Delivered to Buzz",
        } satisfies ActivityEvent,
      }));
    const activity = [...runtimeEvents, ...deliveryEvents]
      .sort((left, right) => right.timestamp - left.timestamp)
      .map(({ event }) => event);
    const newest = activity[0];
    ensureChannel(page.channelId).workstreams[0].agents.push({
      id: page.agentPubkey,
      pubkey: page.agentPubkey,
      agentName: page.agentName,
      role: origin === "remote"
        ? `Remote agent runtime · ${page.sourceLabel ?? "Agent fleet"}`
        : "Local agent runtime",
      status: page.status,
      statusLabel: page.status === "working" ? "Working" : "Complete",
      operation: newest?.title ?? "Waiting for runtime activity",
      elapsed: elapsedTime(page.startedAt, page.completedAt),
      lastActivity: newest?.at ?? "No events",
      model: page.model,
      branch: "Not inspected",
      head: "Not inspected",
      helperCount: 0,
      activity,
      context: page.context,
      evidence: page.evidence,
      artifacts: page.artifacts,
    });
  }

  const fallbackChannelId = presentation.fleetChannelId
    ?? sources[0]?.page.channelId
    ?? [...presentation.channels.keys()][0]
    ?? "unknown-channel";
  for (const source of unavailable) {
    ensureChannel(source.channelId ?? fallbackChannelId).workstreams[0].agents.push({
      id: source.agentPubkey,
      pubkey: source.agentPubkey,
      agentName: source.agentName,
      role: `Remote agent runtime · ${source.sourceLabel}`,
      status: "idle",
      statusLabel: "Unavailable",
      operation: source.detail,
      elapsed: "—",
      lastActivity: "No live source",
      model: "Not exposed",
      branch: "Not inspected",
      head: "Not inspected",
      helperCount: 0,
      activity: [],
      context: [],
      evidence: [],
      artifacts: [],
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    viewerName: presentation.viewerName,
    workspaceName: presentation.workspaceName,
    relayUrl: presentation.relayUrl,
    source: "runtime",
    channels: [...channels.values()],
  };
}

const MAX_RELAY_AUTHORS = 50;

export function channelAuthorPubkeys(
  channel: WorkspaceChannel,
  fleet: RemoteFleetDocument | undefined,
): string[] {
  const authors = new Set<string>((channel.authors ?? []).map((author) => author.pubkey));
  for (const page of fleet?.pages ?? []) {
    if (page.channelId === channel.id) authors.add(page.agentPubkey);
  }
  for (const error of fleet?.errors ?? []) {
    if (error.channelId === channel.id) authors.add(error.agentPubkey);
  }
  return [...authors].slice(0, MAX_RELAY_AUTHORS);
}

class CompanionDataSource implements TowerDataSource {
  async loadSnapshot(): Promise<SnapshotLoadResult> {
    if (!isTauri()) {
      return {
        snapshot: structuredClone(fixtureSnapshot),
        connection: {
          state: "fixture",
          label: "Fixture stream",
          detail: "Browser preview cannot access the native read-only relay adapter.",
        },
      };
    }

    let workspace: WorkspaceDocument;
    try {
      workspace = await invoke<WorkspaceDocument>("load_workspace_profile");
    } catch (error) {
      return {
        snapshot: structuredClone(fixtureSnapshot),
        connection: {
          state: "error",
          label: "Workspace profile invalid",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const profile = workspace.profile;
    const presentation = presentationFromProfile(profile);
    const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const hasCollectors = (profile.collectors?.length ?? 0) > 0;

    const [localRuntime, remoteFleet] = await Promise.allSettled([
      profile.localRuntime
        ? invoke<RuntimeWorkstreamPage>("load_local_workstream", {
            channelId: profile.localRuntime.channelId,
            agentPubkey: profile.localRuntime.agentPubkey,
            agentName: profile.localRuntime.agentName,
          })
        : Promise.reject(new Error("no local runtime is configured")),
      hasCollectors
        ? invoke<RemoteFleetDocument>("load_fleet_workstreams")
        : Promise.reject(new Error("no fleet collectors are configured")),
    ]);
    const localPage = localRuntime.status === "fulfilled" ? localRuntime.value : undefined;
    const remoteDocument = remoteFleet.status === "fulfilled" ? remoteFleet.value : undefined;

    const relayPages = new Map<string, RelayActivityPage>();
    const relayFailures: string[] = [];
    await Promise.all(profile.channels.map(async (channel) => {
      const authorPubkeys = channelAuthorPubkeys(channel, remoteDocument);
      if (authorPubkeys.length === 0) return;
      try {
        const page = await invoke<RelayActivityPage>("load_channel_activity", {
          relayUrl: profile.relayUrl,
          channelId: channel.id,
          authorPubkeys,
          since,
          limit: 100,
        });
        relayPages.set(channel.id, page);
      } catch (error) {
        relayFailures.push(error instanceof Error ? error.message : String(error));
      }
    }));

    const sources: RuntimeSource[] = [];
    for (const page of remoteDocument?.pages ?? []) {
      sources.push({ page, relayPage: relayPages.get(page.channelId), origin: "remote" });
    }
    if (localPage) {
      sources.push({ page: localPage, relayPage: relayPages.get(localPage.channelId), origin: "local" });
    }

    const collectorFailures = (remoteDocument?.collectorErrors ?? [])
      .map((collectorError) => `${collectorError.label}: ${collectorError.detail}`);
    if (sources.length > 0 || (remoteDocument?.errors.length ?? 0) > 0) {
      const hasRemote = Boolean(remoteDocument);
      const hasLocal = Boolean(localPage);
      const notes = [
        `Workspace ${profile.workspace} via ${profile.relayUrl}.`,
        hasRemote
          ? `${remoteDocument?.pages.length ?? 0} live fleet sources and ${remoteDocument?.errors.length ?? 0} unavailable; no VM or Buzz credential is stored in the companion.`
          : "Source-redacted local execution; no fleet collector responded.",
        ...collectorFailures,
      ];
      return {
        snapshot: runtimePagesSnapshot(sources, remoteDocument?.errors, presentation),
        connection: {
          state: "connected",
          label: hasRemote && hasLocal ? "Fleet + local" : hasRemote ? "Agent fleet" : "Local runtime",
          detail: notes.join(" "),
        },
      };
    }

    if (relayPages.size > 0) {
      return {
        snapshot: relayPagesSnapshot([...relayPages.values()], presentation),
        connection: {
          state: "connected",
          label: "Public relay",
          detail: `Read-only signed channel events from ${profile.relayUrl}. No matching agent runtime is active.`,
        },
      };
    }

    const failures = [remoteFleet, localRuntime]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    failures.push(...relayFailures, ...collectorFailures);
    const message = relayFailures[0] || failures[0] || "No companion data source is available.";
    const setupRequired = message.includes("authorization required")
      || message.includes("not authorized");
    return {
      snapshot: structuredClone(fixtureSnapshot),
      connection: {
        state: setupRequired ? "setup-required" : "error",
        label: setupRequired ? "Authorize device" : "Relay unavailable",
        detail: setupRequired
          ? `Add this device identity to ${profile.relayUrl} and the configured channels to enable signed public activity.`
          : message,
      },
    };
  }
}

export const dataSource: TowerDataSource = new CompanionDataSource();
