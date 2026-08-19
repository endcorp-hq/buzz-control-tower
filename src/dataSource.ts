import { invoke, isTauri } from "@tauri-apps/api/core";
import { fixtureSnapshot } from "./fixtures";
import type { ActivityEvent, SnapshotLoadResult, TowerSnapshot } from "./domain";

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

    try {
      const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
      const page = await invoke<RelayActivityPage>("load_channel_activity", {
        relayUrl: RELAY_URL,
        channelId: CONTROL_TOWER_CHANNEL_ID,
        authorPubkeys: [LUCAS_FIZZ_PUBKEY],
        since,
        limit: 100,
      });
      return {
        snapshot: relaySnapshot(page),
        connection: {
          state: "connected",
          label: "Public relay",
          detail: "Read-only signed channel events. Internal turns and prompts are not exposed.",
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
}

export const dataSource: TowerDataSource = new CompanionDataSource();
