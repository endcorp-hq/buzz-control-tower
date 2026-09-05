import { invoke, isTauri } from "@tauri-apps/api/core";
import { fixtureSnapshot } from "./fixtures";
import { deriveManifest } from "./derivedContext";
import type {
  ActivityEvent,
  WorkspaceSummary,
  AgentStatus,
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
  /** Present on legacy single-profile files only; document entries omit it. */
  version?: number;
  /** Workspace id inside the document (derived from the relay host). */
  id?: string;
  workspace: string;
  viewerName: string;
  relayUrl: string;
  channels: WorkspaceChannel[];
  collectors?: WorkspaceCollector[];
  localRuntime?: { channelId: string; agentPubkey: string; agentName: string };
};

export type { WorkspaceSummary } from "./domain";

export type WorkspaceState = {
  path: string;
  /** The active workspace's profile; null/undefined means onboarding. */
  profile?: WorkspaceProfile | null;
  activeWorkspaceId?: string | null;
  /** Every workspace in the document, in document order (one relay each). */
  workspaces?: WorkspaceSummary[];
};

export type NewWorkspace = {
  relayUrl: string;
  workspace: string;
  viewerName: string;
  channel: ChannelSummary;
};

/** Add a workspace (one relay + first channel) and make it active. */
export function addWorkspace(input: NewWorkspace): Promise<WorkspaceState> {
  return invoke<WorkspaceState>("add_workspace", {
    relayUrl: input.relayUrl,
    workspace: input.workspace,
    viewerName: input.viewerName,
    channelId: input.channel.id,
    channelName: input.channel.name,
    channelDescription: input.channel.description,
  });
}

/** Make another workspace active; every relay read retargets on the next refresh. */
export function switchWorkspace(workspaceId: string): Promise<WorkspaceState> {
  return invoke<WorkspaceState>("switch_workspace", { workspaceId });
}

export function removeWorkspace(workspaceId: string): Promise<WorkspaceState> {
  return invoke<WorkspaceState>("remove_workspace", { workspaceId });
}

export type ChannelSummary = { id: string; name: string; description: string };

export function listRelayChannels(relayUrl: string): Promise<ChannelSummary[]> {
  return invoke<ChannelSummary[]>("list_relay_channels", { relayUrl });
}

export function discoverChannelSummary(
  relayUrl: string,
  channelId: string,
): Promise<ChannelDirectory> {
  return invoke<ChannelDirectory>("discover_channel_directory", { relayUrl, channelId });
}

export function addWorkspaceChannel(channel: ChannelSummary): Promise<WorkspaceState> {
  return invoke<WorkspaceState>("add_workspace_channel", {
    channelId: channel.id,
    channelName: channel.name,
    channelDescription: channel.description,
  });
}

export function removeWorkspaceChannel(channelId: string): Promise<WorkspaceState> {
  return invoke<WorkspaceState>("remove_workspace_channel", { channelId });
}

export type DirectoryMember = {
  pubkey: string;
  name?: string;
  role: string;
  isAgent: boolean;
};

export type ChannelDirectory = {
  channelId: string;
  name: string;
  description: string;
  members: DirectoryMember[];
};

export type WorkspacePresentation = {
  workspaceName: string;
  viewerName: string;
  relayUrl?: string;
  channels: Map<string, { name: string; description: string }>;
  authorNames: Map<string, string>;
  authorRoles: Map<string, string>;
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
    authorRoles: new Map(),
    fleetChannelId: profile.collectors?.[0]?.channelId,
  };
}

export function unavailableSnapshot(presentation?: WorkspacePresentation): TowerSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    viewerName: presentation?.viewerName ?? "Operator",
    workspaceName: presentation?.workspaceName ?? "Control Tower",
    relayUrl: presentation?.relayUrl,
    source: "unavailable",
    channels: [],
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

export type TelemetryActivityEntry = {
  at?: string | null;
  kind?: string | null;
  title?: string | null;
  status?: string | null;
};

export type AgentTelemetry = {
  pubkey: string;
  eventCreatedAt: number;
  status: "working" | "complete" | "error" | "idle";
  model?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  turnStartedAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  stopReason?: string | null;
  activity: TelemetryActivityEntry[];
};

export type RelayTelemetryPage = {
  channelId: string;
  statuses: AgentTelemetry[];
};

export type TelemetryPages = Map<string, RelayTelemetryPage>;

export type RichEntry = {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail: string;
  status?: string | null;
  parameters: Array<{ label: string; value: string }>;
  result?: string | null;
};

export type ObserverAgentStream = {
  agentPubkey: string;
  channelId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  updatedAt: number;
  liveText: string;
  liveThought: string;
  entries: RichEntry[];
};

export type TypingHeartbeat = {
  agentPubkey: string;
  channelId: string;
  /** Unix seconds (companion clock) when the heartbeat was received. */
  seenAt: number;
};

export type ObserverStreamsPage = {
  relayUrl: string;
  connected: boolean;
  lastError?: string | null;
  agents: ObserverAgentStream[];
  typing?: TypingHeartbeat[];
};

export type ObserverStreams = Map<string, ObserverAgentStream>;

export function observerStreamsByAgent(page: ObserverStreamsPage | undefined): ObserverStreams {
  const byAgent: ObserverStreams = new Map();
  for (const agent of page?.agents ?? []) byAgent.set(agent.agentPubkey, agent);
  return byAgent;
}

export type PresenceEntry = { pubkey: string; status: string };
export type PresencePage = { statuses: PresenceEntry[] };

/** Typing heartbeats stay "active" this long — 3× the harness's ~3 s refresh,
 * so one dropped ephemeral event does not flicker the chip. */
export const TYPING_ACTIVE_WINDOW_S = 10;

/**
 * Stock-harness liveness signals: typing heartbeats keyed channel → pubkey →
 * seen-at, and relay presence keyed pubkey → status. Both are best-effort
 * enrichments for agents whose harness publishes no work-status telemetry.
 */
export type LiveSignals = {
  typing?: Map<string, Map<string, number>>;
  presence?: Map<string, string>;
  /** Test injection point; defaults to Date.now(). */
  nowMs?: number;
};

export function typingByChannel(
  page: ObserverStreamsPage | undefined,
): Map<string, Map<string, number>> {
  const byChannel = new Map<string, Map<string, number>>();
  for (const heartbeat of page?.typing ?? []) {
    let channel = byChannel.get(heartbeat.channelId);
    if (!channel) {
      channel = new Map();
      byChannel.set(heartbeat.channelId, channel);
    }
    const existing = channel.get(heartbeat.agentPubkey);
    if (existing === undefined || heartbeat.seenAt > existing) {
      channel.set(heartbeat.agentPubkey, heartbeat.seenAt);
    }
  }
  return byChannel;
}

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

export type ChannelRosters = Map<string, ChannelRoster>;

// Relay-derived cards arrive in whatever order the relay returned messages
// (and roster discovery resolved), which changes from poll to poll. Sort them
// by display name so a card keeps its place in the sidebar between refreshes.
function sortAgentsByName<T extends { agentName: string; pubkey: string }>(agents: T[]): T[] {
  return [...agents].sort((left, right) =>
    left.agentName.localeCompare(right.agentName, undefined, { sensitivity: "base" })
      || left.pubkey.localeCompare(right.pubkey));
}

function groupMessagesByAuthor(page: RelayActivityPage | undefined): Map<string, RelayMessage[]> {
  const byAuthor = new Map<string, RelayMessage[]>();
  for (const message of page?.messages ?? []) {
    const existing = byAuthor.get(message.pubkey);
    if (existing) existing.push(message);
    else byAuthor.set(message.pubkey, [message]);
  }
  return byAuthor;
}

// Map an agent-reported telemetry status onto the card status union.
// "error" has no dedicated AgentStatus variant, so it renders as "blocked"
// with an explicit "Turn error" label.
const TELEMETRY_STATUS_CARD: Record<
  AgentTelemetry["status"],
  { status: AgentStatus; statusLabel: string }
> = {
  working: { status: "working", statusLabel: "Working" },
  complete: { status: "complete", statusLabel: "Turn complete" },
  error: { status: "blocked", statusLabel: "Turn error" },
  idle: { status: "idle", statusLabel: "Idle" },
};

const MAX_TELEMETRY_ACTIVITY = 20;

// How long a completed turn keeps its "Turn complete" card before the agent
// reads as plain idle again. Status events are replaceable, so the last turn's
// snapshot persists on the relay indefinitely — without this window a card
// would say "Turn complete" forever.
const COMPLETE_TURN_LINGER_MS = 5 * 60_000;

function activityEventKind(kind: string | null | undefined): ActivityEvent["kind"] {
  return kind === "tool" || kind === "message" || kind === "evidence" || kind === "lifecycle"
    ? kind
    : "lifecycle";
}

function activityEventStatus(status: string | null | undefined): ActivityEvent["status"] {
  return status === "running" || status === "complete" || status === "failed"
    ? status
    : undefined;
}

// Once the agent's own summary says the turn is over, nothing in the snapshot
// is still running. The harness never closes out the final streaming entry, so
// a finished turn would otherwise keep a pulsing "Streaming reply" forever.
function settledStatus(
  status: ActivityEvent["status"],
  turnOver: boolean,
): ActivityEvent["status"] {
  return turnOver && status === "running" ? "complete" : status;
}

function settledTitle(title: string, turnOver: boolean): string {
  return turnOver && title === "Streaming reply" ? "Reply sent" : title;
}

// Telemetry activity arrives newest-last; render it newest-first like the
// runtime lanes do.
function activityFromTelemetry(telemetry: AgentTelemetry): ActivityEvent[] {
  const turnOver = telemetry.status !== "working";
  return telemetry.activity
    .slice(-MAX_TELEMETRY_ACTIVITY)
    .map((entry, index): ActivityEvent => ({
      id: `${telemetry.pubkey}-telemetry-${index}`,
      at: entry.at ? clockTime(entry.at) : "—",
      kind: activityEventKind(entry.kind),
      title: settledTitle(entry.title || "Agent activity", turnOver),
      detail: "Reported by agent work-status telemetry.",
      status: settledStatus(activityEventStatus(entry.status), turnOver),
    }))
    .reverse();
}

// Decrypted rich-lane entries arrive newest-first from the backend and are
// already shaped like ActivityEvents; normalize kinds/status and clock-format
// the timestamps.
function activityFromObserverStream(
  stream: ObserverAgentStream,
  turnOver: boolean,
): ActivityEvent[] {
  return stream.entries.map((entry): ActivityEvent => ({
    id: `${stream.agentPubkey}-rich-${entry.id}`,
    at: entry.at ? clockTime(entry.at) : "—",
    kind: activityEventKind(entry.kind),
    title: settledTitle(entry.title, turnOver),
    detail: entry.detail,
    status: settledStatus(activityEventStatus(entry.status), turnOver),
    parameters: entry.parameters.length > 0 ? entry.parameters : undefined,
    result: entry.result ?? undefined,
  }));
}

function channelObserverStream(
  observerStreams: ObserverStreams | undefined,
  channelId: string,
  pubkey: string,
): ObserverAgentStream | undefined {
  const stream = observerStreams?.get(pubkey);
  if (!stream) return undefined;
  return !stream.channelId || stream.channelId === channelId ? stream : undefined;
}

// A relay-derived agent card. A member with no signed events in the window is
// still rendered, as a quiet idle card, so the discovered roster never shrinks
// to just the recent speakers. Agent-published work-status telemetry, when
// present, enriches the card with live status, model, and activity.
function relayAgentCard(
  channelId: string,
  pubkey: string,
  messages: RelayMessage[],
  presentation: WorkspacePresentation,
  telemetry?: AgentTelemetry,
  observer?: ObserverAgentStream,
  signals?: LiveSignals,
) {
  const newest = messages.at(-1);
  const nowMs = signals?.nowMs ?? Date.now();
  const live = telemetry?.status === "working";
  const lingering =
    telemetry?.status === "complete" &&
    nowMs - telemetry.eventCreatedAt * 1000 <= COMPLETE_TURN_LINGER_MS;
  // Telemetry is the agent's own trusted summary and always wins. Without it,
  // fall back to the stock-harness liveness ladder: a fresh typing heartbeat
  // means mid-turn now; relay presence separates "online but idle" from
  // "harness gone"; an agent that is neither present nor recently signed
  // dims to offline.
  const typingSeenAt = signals?.typing?.get(channelId)?.get(pubkey);
  const typingActive =
    typingSeenAt !== undefined && nowMs / 1000 - typingSeenAt <= TYPING_ACTIVE_WINDOW_S;
  const presence = signals?.presence?.get(pubkey);
  const liveSignalCard = typingActive
    ? { status: "active" as const, statusLabel: "Active" }
    : presence === "online" || presence === "away"
      ? { status: "idle" as const, statusLabel: presence === "away" ? "Away" : "Online" }
      : presence === "offline" || (signals?.presence && !newest)
        ? { status: "offline" as const, statusLabel: "Offline" }
        : undefined;
  const card = telemetry
    ? telemetry.status === "complete" && !lingering
      ? TELEMETRY_STATUS_CARD.idle
      : TELEMETRY_STATUS_CARD[telemetry.status]
    : liveSignalCard;
  // The decrypted rich lane supersedes the redacted telemetry activity list
  // (every telemetry title also exists as a richer entry); telemetry still
  // owns card status, model, and timings — it is the agent's own summary.
  const richActivity = observer ? activityFromObserverStream(observer, !live) : [];
  const manifest = observer ? deriveManifest(observer.entries, clockTime) : { context: [], artifacts: [] };
  const telemetryActivity = richActivity.length > 0
    ? richActivity
    : telemetry
      ? activityFromTelemetry(telemetry)
      : [];
  const newestTelemetry = telemetryActivity[0];
  const elapsed = telemetry?.turnStartedAt
    ? telemetry.status === "working"
      ? elapsedTime(telemetry.turnStartedAt)
      : telemetry.completedAt
        ? elapsedTime(telemetry.turnStartedAt, telemetry.completedAt)
        : "—"
    : "—";
  return {
    id: `${channelId}-${pubkey}`,
    pubkey,
    agentName: authorName(presentation, pubkey),
    role: presentation.authorRoles.get(pubkey) ?? "Channel participant",
    status: (card?.status ?? "idle") as AgentStatus,
    statusLabel: card?.statusLabel ?? (newest ? "Relay visible" : "Quiet"),
    operation: newestTelemetry?.title
      ?? (typingActive && !telemetry
        ? "Mid-turn now — no status telemetry feed from this participant"
        : newest
          ? "Showing signed public channel updates"
          : "No signed channel events in the last 24 hours"),
    elapsed,
    lastActivity: telemetry?.updatedAt
      ? new Date(telemetry.updatedAt).toLocaleTimeString()
      : typingActive && !telemetry
        ? "Active now"
        : newest
          ? new Date(newest.createdAt * 1000).toLocaleTimeString()
          : "No recent events",
    model: telemetry?.model ?? "Not exposed",
    branch: "Not exposed",
    head: "Not exposed",
    helperCount: 0,
    activity: [...telemetryActivity, ...[...messages].reverse().map(activityFromMessage)],
    liveText: observer?.liveText || undefined,
    liveThought: observer?.liveThought || undefined,
    // No collector on the agent host: the manifest is whatever the rich lane
    // shows the turn reading and writing. Evidence stays empty — a delivery
    // chain must not be inferred from tool activity.
    context: manifest.context,
    evidence: [],
    artifacts: manifest.artifacts,
  };
}

function channelTelemetry(
  telemetryPages: TelemetryPages | undefined,
  channelId: string,
  pubkey: string,
): AgentTelemetry | undefined {
  return telemetryPages?.get(channelId)?.statuses.find((status) => status.pubkey === pubkey);
}

export function relayPagesSnapshot(
  pages: RelayActivityPage[],
  presentation: WorkspacePresentation = DEFAULT_PRESENTATION,
  rosters?: ChannelRosters,
  telemetryPages?: TelemetryPages,
  observerStreams?: ObserverStreams,
  signals?: LiveSignals,
): TowerSnapshot {
  const channels: TowerSnapshot["channels"] = [];
  for (const page of pages) {
    const meta = channelPresentation(presentation, page.channelId);
    const byAuthor = groupMessagesByAuthor(page);
    // The viewer's own device key is a channel member too (that is how it
    // reads the channel) but it is never an agent to observe: keep it off
    // the roster instead of showing a nameless card for it.
    const pubkeys = [...byAuthor.keys()].filter((pubkey) => pubkey !== page.devicePubkey);
    for (const pubkey of rosters?.get(page.channelId)?.authorPubkeys ?? []) {
      if (!byAuthor.has(pubkey) && pubkey !== page.devicePubkey) pubkeys.push(pubkey);
    }
    const agents = sortAgentsByName(pubkeys.map((pubkey) =>
      relayAgentCard(page.channelId, pubkey, byAuthor.get(pubkey) ?? [], presentation,
        channelTelemetry(telemetryPages, page.channelId, pubkey),
        channelObserverStream(observerStreams, page.channelId, pubkey), signals)));
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
  const time = date.toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  // A bare clock time on an entry from a previous day reads as "today"; make
  // the staleness visible.
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString("en", { month: "short", day: "numeric" })} ${time}`;
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
  rosters?: ChannelRosters,
  relayPages?: Map<string, RelayActivityPage>,
  telemetryPages?: TelemetryPages,
  observerStreams?: ObserverStreams,
  signals?: LiveSignals,
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

  // Every discovered roster member without a runtime lane still gets a card,
  // grouped under a per-channel roster workstream, so the full channel roster
  // is visible even when only some agents have live collectors.
  for (const [channelId, roster] of rosters ?? []) {
    const channel = ensureChannel(channelId);
    const covered = new Set(
      channel.workstreams.flatMap((workstream) => workstream.agents.map((agent) => agent.pubkey)),
    );
    const devicePubkey = relayPages?.get(channelId)?.devicePubkey;
    const quiet = roster.authorPubkeys.filter((pubkey) => !covered.has(pubkey) && pubkey !== devicePubkey);
    if (quiet.length === 0) continue;
    const byAuthor = groupMessagesByAuthor(relayPages?.get(channelId));
    channel.workstreams.push({
      id: `${channelId}-channel-roster`,
      title: "Channel roster",
      phase: "Relay-discovered",
      agents: sortAgentsByName(quiet.map((pubkey) =>
        relayAgentCard(channelId, pubkey, byAuthor.get(pubkey) ?? [], presentation,
          channelTelemetry(telemetryPages, channelId, pubkey),
          channelObserverStream(observerStreams, channelId, pubkey), signals))),
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

export type ChannelRoster = {
  authorPubkeys: string[];
  authorNames: Map<string, string>;
  authorRoles: Map<string, string>;
};

// Merge the deterministic sources of "who to watch in this channel":
// configured pins first (their names win and they can never be evicted by
// the author cap), then the live relay roster discovered from signed
// membership and agent-profile events, then the fleet collector roster.
export function mergeChannelRoster(
  channel: WorkspaceChannel,
  directory: ChannelDirectory | undefined,
  fleet: RemoteFleetDocument | undefined,
): ChannelRoster {
  const names = new Map<string, string>();
  const roles = new Map<string, string>();
  const pubkeys = new Set<string>();
  for (const author of channel.authors ?? []) {
    pubkeys.add(author.pubkey);
    if (author.name) names.set(author.pubkey, author.name);
  }
  for (const member of directory?.members ?? []) {
    pubkeys.add(member.pubkey);
    if (member.name && !names.has(member.pubkey)) names.set(member.pubkey, member.name);
    roles.set(member.pubkey, member.isAgent ? "Agent · channel roster" : "Human participant");
  }
  for (const author of channel.authors ?? []) {
    if (!roles.has(author.pubkey)) roles.set(author.pubkey, "Pinned author");
  }
  for (const page of fleet?.pages ?? []) {
    if (page.channelId === channel.id) pubkeys.add(page.agentPubkey);
  }
  for (const error of fleet?.errors ?? []) {
    if (error.channelId === channel.id) pubkeys.add(error.agentPubkey);
  }
  return {
    authorPubkeys: [...pubkeys].slice(0, MAX_RELAY_AUTHORS),
    authorNames: names,
    authorRoles: roles,
  };
}

// A configured channel with no reachable relay page (empty roster, discovery
// refused, fresh add with no activity yet) would otherwise vanish from the
// snapshot entirely, which reads as a broken add. Give every profile channel a
// node — an empty one renders as a quiet channel — and record the configured
// ids so the sidebar knows which channels are editable.
//
// Channels are emitted in profile order. The snapshot builders collect relay
// pages as their parallel fetches resolve, so their own order changes from
// poll to poll; pinning to the profile keeps the sidebar from reshuffling
// every refresh. Channels the profile does not list (fleet-discovered ones)
// follow in the order they were found.
export function withConfiguredChannels(
  snapshot: TowerSnapshot,
  profileChannels: WorkspaceChannel[],
): TowerSnapshot {
  const byId = new Map(snapshot.channels.map((channel) => [channel.id, channel]));
  const configured = profileChannels.map((channel) =>
    byId.get(channel.id) ?? {
      id: channel.id,
      name: channel.name,
      description: channel.description ?? "",
      workstreams: [],
    });
  const configuredIds = new Set(profileChannels.map((channel) => channel.id));
  const unlisted = snapshot.channels.filter((channel) => !configuredIds.has(channel.id));
  return {
    ...snapshot,
    channels: [...configured, ...unlisted],
    configuredChannelIds: profileChannels.map((channel) => channel.id),
  };
}

// Carry the workspace document summary on every snapshot so the header
// switcher can render it whatever the connection state; the active workspace
// is the one every relay read in this snapshot was made against.
export function attachWorkspaces(
  result: SnapshotLoadResult,
  workspace: WorkspaceState | undefined,
): SnapshotLoadResult {
  if (!workspace?.workspaces?.length) return result;
  return {
    ...result,
    snapshot: {
      ...result.snapshot,
      workspaces: workspace.workspaces,
      activeWorkspaceId: workspace.activeWorkspaceId ?? undefined,
    },
  };
}

const DIRECTORY_TTL_MS = 60_000;
const directoryCache = new Map<string, { at: number; directory: ChannelDirectory }>();

class CompanionDataSource implements TowerDataSource {
  private lastWorkspaceState?: WorkspaceState;

  async loadSnapshot(): Promise<SnapshotLoadResult> {
    const result = await this.loadActiveWorkspace();
    return attachWorkspaces(result, this.lastWorkspaceState);
  }

  private async loadActiveWorkspace(): Promise<SnapshotLoadResult> {
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

    let workspace: WorkspaceState;
    try {
      workspace = await invoke<WorkspaceState>("load_workspace_state");
    } catch (error) {
      return {
        snapshot: unavailableSnapshot(),
        connection: {
          state: "error",
          label: "Workspace profile invalid",
          detail: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
    }
    this.lastWorkspaceState = workspace;
    if (!workspace.profile) {
      return {
        snapshot: structuredClone(fixtureSnapshot),
        connection: {
          state: "onboarding",
          label: "Set up your workspace",
          detail: `No workspace profile exists yet (${workspace.path}). Pick your relay and channel to start observing.`,
        },
      };
    }
    const profile = workspace.profile;
    this.lastWorkspaceState = workspace;
    const presentation = presentationFromProfile(profile);
    const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const hasCollectors = (profile.collectors?.length ?? 0) > 0;

    // Keep the live encrypted rich-lane subscription running (idempotent) and
    // read whatever it has accumulated. Both are best-effort: their failure
    // degrades to telemetry-only cards.
    const [, observerPage] = await Promise.allSettled([
      invoke<void>("start_observer_stream", {
        relayUrl: profile.relayUrl,
        channels: profile.channels.map((channel) => channel.id),
      }),
      invoke<ObserverStreamsPage>("load_observer_streams"),
    ]);
    const observerStreams = observerStreamsByAgent(
      observerPage.status === "fulfilled" ? observerPage.value : undefined,
    );
    const signals: LiveSignals = {
      typing: typingByChannel(
        observerPage.status === "fulfilled" ? observerPage.value : undefined,
      ),
    };
    // Populated lazily on the first successful presence read: an outage must
    // leave `presence` undefined so quiet cards degrade to the old neutral
    // "Quiet" instead of all dimming to a false "Offline".
    const presenceStatuses = new Map<string, string>();

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
    const telemetryPages: TelemetryPages = new Map();
    const rosters: ChannelRosters = new Map();
    const relayFailures: string[] = [];
    await Promise.all(profile.channels.map(async (channel) => {
      // Discover the live roster from signed relay events (cached briefly so
      // the five-second refresh does not hammer the relay). A discovery
      // failure falls back to the last known roster, then to configured pins.
      const cacheKey = `${profile.relayUrl}|${channel.id}`;
      const cached = directoryCache.get(cacheKey);
      let directory = cached?.directory;
      if (!cached || Date.now() - cached.at >= DIRECTORY_TTL_MS) {
        try {
          directory = await invoke<ChannelDirectory>("discover_channel_directory", {
            relayUrl: profile.relayUrl,
            channelId: channel.id,
          });
          directoryCache.set(cacheKey, { at: Date.now(), directory });
        } catch (error) {
          if (!directory) {
            relayFailures.push(error instanceof Error ? error.message : String(error));
          }
        }
      }
      const roster = mergeChannelRoster(channel, directory, remoteDocument);
      rosters.set(channel.id, roster);
      for (const [pubkey, name] of roster.authorNames) {
        if (!presentation.authorNames.has(pubkey)) presentation.authorNames.set(pubkey, name);
      }
      for (const [pubkey, role] of roster.authorRoles) {
        presentation.authorRoles.set(pubkey, role);
      }
      if (roster.authorPubkeys.length === 0) return;
      // Fetch signed activity, agent work-status telemetry, and relay
      // presence side by side. Telemetry and presence are best-effort: their
      // failure alone degrades silently to un-enriched cards; only a channel
      // where the activity read also fails surfaces a failure note.
      const [activity, telemetry, presence] = await Promise.allSettled([
        invoke<RelayActivityPage>("load_channel_activity", {
          relayUrl: profile.relayUrl,
          channelId: channel.id,
          authorPubkeys: roster.authorPubkeys,
          since,
          limit: 100,
        }),
        invoke<RelayTelemetryPage>("load_channel_telemetry", {
          relayUrl: profile.relayUrl,
          channelId: channel.id,
          authorPubkeys: roster.authorPubkeys,
        }),
        invoke<PresencePage>("load_presence", {
          relayUrl: profile.relayUrl,
          pubkeys: roster.authorPubkeys,
        }),
      ]);
      if (activity.status === "fulfilled") {
        relayPages.set(channel.id, activity.value);
      }
      if (telemetry.status === "fulfilled") {
        telemetryPages.set(channel.id, telemetry.value);
      }
      if (presence.status === "fulfilled") {
        signals.presence = presenceStatuses;
        for (const entry of presence.value.statuses) {
          presenceStatuses.set(entry.pubkey, entry.status);
        }
      }
      if (activity.status === "rejected") {
        relayFailures.push(
          activity.reason instanceof Error ? activity.reason.message : String(activity.reason));
        if (telemetry.status === "rejected") {
          const detail = telemetry.reason instanceof Error
            ? telemetry.reason.message
            : String(telemetry.reason);
          relayFailures.push(`telemetry: ${detail}`);
        }
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
        snapshot: withConfiguredChannels(runtimePagesSnapshot(
          sources, remoteDocument?.errors, presentation, rosters, relayPages, telemetryPages,
          observerStreams, signals), profile.channels),
        connection: {
          state: "connected",
          label: hasRemote && hasLocal ? "Fleet + local" : hasRemote ? "Agent fleet" : "Local runtime",
          detail: notes.join(" "),
        },
      };
    }

    if (relayPages.size > 0) {
      return {
        snapshot: withConfiguredChannels(relayPagesSnapshot(
          [...relayPages.values()], presentation, rosters, telemetryPages, observerStreams,
          signals), profile.channels),
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
      snapshot: unavailableSnapshot(presentation),
      connection: {
        state: setupRequired ? "setup-required" : "error",
        label: setupRequired ? "Authorize device" : "Relay unavailable",
        detail: setupRequired
          ? `Add this device identity to ${profile.relayUrl} and the configured channels to enable signed public activity.`
          : message,
        retryable: !setupRequired,
      },
    };
  }
}

export const dataSource: TowerDataSource = new CompanionDataSource();
