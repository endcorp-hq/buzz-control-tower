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

const RELAY_URL = "wss://buzz.nilor.cool";
const CONTROL_TOWER_CHANNEL_ID = "0b7c0958-3f7f-48c8-af3f-31e549b10e31";
const LUCAS_FIZZ_PUBKEY = "19215c80f8a71880f8c5738410d041e8afb2093bde1df8b4b691f23a50cb8b13";
const MOS_BOSTON_CHANNEL_ID = "1da2b83b-c1e5-44b3-8a1c-546bf665933e";
export const MOS_AGENT_PUBKEY = "e802d3594a2b31b22f35c6a42a17e1749d62decaceef5abe96841512607fdd00";

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
};

export type RemoteFleetDocument = {
  pages: RuntimeWorkstreamPage[];
  errors: RemoteSourceError[];
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

export function relaySnapshot(page: RelayActivityPage): TowerSnapshot {
  const newest = page.messages.at(-1);
  const activity = [...page.messages].reverse().map(activityFromMessage);
  return {
    generatedAt: new Date().toISOString(),
    viewerName: "Lucas",
    workspaceName: "nilor.cool",
    source: "relay",
    channels: [
      {
        id: page.channelId,
        name: "buzz-control-tower",
        description: "Product development for the Buzz observability companion",
        workstreams: [
          {
            id: "public-relay-activity",
            title: "Signed channel activity",
            phase: "Companion-only",
            agents: [
              {
                id: "fizz-control",
                pubkey: LUCAS_FIZZ_PUBKEY,
                agentName: "Lucas-Fizz",
                role: "Channel participant",
                status: "idle",
                statusLabel: "Relay visible",
                operation: newest
                  ? "Showing signed public channel updates"
                  : "No signed channel updates in the current window",
                elapsed: "—",
                lastActivity: newest
                  ? new Date(newest.createdAt * 1000).toLocaleTimeString()
                  : "No events",
                model: "Not exposed",
                branch: "Not exposed",
                head: "Not exposed",
                helperCount: 0,
                activity,
                context: [],
                evidence: [],
                artifacts: [],
              },
            ],
          },
        ],
      },
    ],
  };
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

function channelPresentation(channelId: string) {
  if (channelId === MOS_BOSTON_CHANNEL_ID) {
    return {
      name: "mos-boston",
      description: "MOS Boston product development and deployment",
    };
  }
  return {
    name: "buzz-control-tower",
    description: "Product development for the Buzz observability companion",
  };
}

export function runtimePagesSnapshot(
  sources: RuntimeSource[],
  unavailable: RemoteSourceError[] = [],
): TowerSnapshot {
  const channels = new Map<string, TowerSnapshot["channels"][number]>();

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
    let channel = channels.get(page.channelId);
    if (!channel) {
      channel = {
        id: page.channelId,
        ...channelPresentation(page.channelId),
        workstreams: [
          {
            id: `${page.channelId}-live-execution`,
            title: "Live agent execution",
            phase: "Source-redacted",
            agents: [],
          },
        ],
      };
      channels.set(page.channelId, channel);
    }
    channel.workstreams[0].agents.push(
      {
                id: page.agentPubkey,
                pubkey: page.agentPubkey,
                agentName: page.agentName,
                role: origin === "remote"
                  ? `Remote agent runtime · ${page.sourceLabel ?? "MOS fleet"}`
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
      },
    );
  }

  if (unavailable.length > 0) {
    let channel = channels.get(MOS_BOSTON_CHANNEL_ID);
    if (!channel) {
      channel = {
        id: MOS_BOSTON_CHANNEL_ID,
        ...channelPresentation(MOS_BOSTON_CHANNEL_ID),
        workstreams: [{
          id: `${MOS_BOSTON_CHANNEL_ID}-live-execution`,
          title: "Live agent execution",
          phase: "Source-redacted",
          agents: [],
        }],
      };
      channels.set(MOS_BOSTON_CHANNEL_ID, channel);
    }
    for (const source of unavailable) {
      channel.workstreams[0].agents.push({
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
  }

  return {
    generatedAt: new Date().toISOString(),
    viewerName: "Lucas",
    workspaceName: "nilor.cool",
    source: "runtime",
    channels: [...channels.values()],
  };
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

    const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const [localRuntime, remoteFleet, localRelay] = await Promise.allSettled([
      invoke<RuntimeWorkstreamPage>("load_local_workstream", {
        channelId: CONTROL_TOWER_CHANNEL_ID,
        agentPubkey: LUCAS_FIZZ_PUBKEY,
        agentName: "Lucas-Fizz",
      }),
      invoke<RemoteFleetDocument>("load_mos_fleet_workstreams"),
      invoke<RelayActivityPage>("load_channel_activity", {
        relayUrl: RELAY_URL,
        channelId: CONTROL_TOWER_CHANNEL_ID,
        authorPubkeys: [LUCAS_FIZZ_PUBKEY],
        since,
        limit: 100,
      }),
    ]);

    const localPage = localRuntime.status === "fulfilled" ? localRuntime.value : undefined;
    const remoteDocument = remoteFleet.status === "fulfilled" ? remoteFleet.value : undefined;
    const localRelayPage = localRelay.status === "fulfilled" ? localRelay.value : undefined;
    let remoteRelayPage: RelayActivityPage | undefined;
    let remoteRelayFailure: unknown;
    if (remoteDocument) {
      try {
        remoteRelayPage = await invoke<RelayActivityPage>("load_channel_activity", {
          relayUrl: RELAY_URL,
          channelId: MOS_BOSTON_CHANNEL_ID,
          authorPubkeys: fleetRosterPubkeys(remoteDocument),
          since,
          limit: 100,
        });
      } catch (error) {
        remoteRelayFailure = error;
      }
    }
    const sources: RuntimeSource[] = [];
    for (const page of remoteDocument?.pages ?? []) {
      sources.push({ page, relayPage: remoteRelayPage, origin: "remote" });
    }
    if (localPage) sources.push({ page: localPage, relayPage: localRelayPage, origin: "local" });

    if (sources.length > 0 || (remoteDocument?.errors.length ?? 0) > 0) {
      const hasRemote = Boolean(remoteDocument);
      const hasLocal = Boolean(localPage);
      return {
        snapshot: runtimePagesSnapshot(sources, remoteDocument?.errors),
        connection: {
          state: "connected",
          label: hasRemote && hasLocal ? "MOS fleet + local" : hasRemote ? "MOS fleet" : "Local runtime",
          detail: hasRemote
            ? `${remoteDocument?.pages.length ?? 0} live fleet sources and ${remoteDocument?.errors.length ?? 0} unavailable; no VM or Buzz credential is stored in the companion.`
            : "Source-redacted local execution; the MOS fleet collector is currently unavailable.",
        },
      };
    }

    if (localRelayPage) {
      return {
        snapshot: relaySnapshot(localRelayPage),
        connection: {
          state: "connected",
          label: "Public relay",
          detail: "Read-only signed channel events. No matching local runtime is active.",
        },
      };
    }

    const failures = [remoteFleet, localRuntime, localRelay]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (remoteRelayFailure) {
      failures.push(remoteRelayFailure instanceof Error ? remoteRelayFailure.message : String(remoteRelayFailure));
    }
    const message = failures[0] || "No companion data source is available.";
    const setupRequired = message.includes("authorization required")
      || message.includes("not authorized");
    return {
      snapshot: structuredClone(fixtureSnapshot),
      connection: {
        state: setupRequired ? "setup-required" : "error",
        label: setupRequired ? "Authorize device" : "Relay unavailable",
        detail: setupRequired
          ? "Add this device identity to the relay and channel to enable signed public activity."
          : message,
      },
    };
  }
}

export const dataSource: TowerDataSource = new CompanionDataSource();
