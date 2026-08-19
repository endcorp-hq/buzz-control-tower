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

export interface TowerDataSource {
  loadSnapshot(): Promise<SnapshotLoadResult>;
}

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
  const runtimeEvents = page.activity.map((event) => ({
    timestamp: new Date(event.at).getTime(),
    event: { ...event, at: clockTime(event.at) } satisfies ActivityEvent,
  }));
  const startedAtSeconds = Math.floor(new Date(page.startedAt).getTime() / 1000);
  const deliveryEvents = (relayPage?.messages ?? [])
    .filter((message) => message.createdAt >= startedAtSeconds)
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

  return {
    generatedAt: new Date().toISOString(),
    viewerName: "Lucas",
    workspaceName: "nilor.cool",
    source: "runtime",
    channels: [
      {
        id: page.channelId,
        name: "buzz-control-tower",
        description: "Product development for the Buzz observability companion",
        workstreams: [
          {
            id: page.turnId,
            title: "Live agent execution",
            phase: "Source-redacted",
            agents: [
              {
                id: "fizz-control",
                pubkey: page.agentPubkey,
                agentName: page.agentName,
                role: "Local agent runtime",
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
            ],
          },
        ],
      },
    ],
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
    let runtimePage: RuntimeWorkstreamPage | undefined;
    let relayPage: RelayActivityPage | undefined;
    let runtimeError = "";
    let relayError = "";

    try {
      runtimePage = await invoke<RuntimeWorkstreamPage>("load_local_workstream", {
        channelId: CONTROL_TOWER_CHANNEL_ID,
        agentPubkey: LUCAS_FIZZ_PUBKEY,
        agentName: "Lucas-Fizz",
      });
    } catch (error) {
      runtimeError = error instanceof Error ? error.message : String(error);
    }

    try {
      relayPage = await invoke<RelayActivityPage>("load_channel_activity", {
        relayUrl: RELAY_URL,
        channelId: CONTROL_TOWER_CHANNEL_ID,
        authorPubkeys: [LUCAS_FIZZ_PUBKEY],
        since,
        limit: 100,
      });
    } catch (error) {
      relayError = error instanceof Error ? error.message : String(error);
    }

    if (runtimePage) {
      return {
        snapshot: runtimeSnapshot(runtimePage, relayPage),
        connection: {
          state: "connected",
          label: "Live runtime",
          detail: relayPage
            ? "Source-redacted local execution plus signed Buzz delivery events."
            : "Source-redacted local execution; Buzz delivery evidence is currently unavailable.",
        },
      };
    }

    if (relayPage) {
      return {
        snapshot: relaySnapshot(relayPage),
        connection: {
          state: "connected",
          label: "Public relay",
          detail: "Read-only signed channel events. No matching local runtime is active.",
        },
      };
    }

    const message = relayError || runtimeError || "No companion data source is available.";
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
