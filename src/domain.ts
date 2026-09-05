export type AgentStatus =
  | "working"
  | "blocked"
  | "idle"
  | "complete"
  /** Mid-turn typing heartbeat seen, but the harness publishes no telemetry. */
  | "active"
  /** Presence reports offline, or nothing signed in the lookback window. */
  | "offline";

export type DeliveryStage =
  | "local"
  | "committed"
  | "pushed"
  | "pr-open"
  | "merged"
  | "deployed";

export type ActivityEvent = {
  id: string;
  at: string;
  kind: "lifecycle" | "tool" | "message" | "evidence";
  title: string;
  detail: string;
  status?: "running" | "complete" | "failed";
  parameters?: Array<{ label: string; value: string }>;
  result?: string;
};

export type ContextSource = {
  id: string;
  kind:
    | "base" | "team" | "memory" | "thread" | "canvas" | "repository"
    /** Derived from the rich lane: a file the agent read, a URL it fetched, a search it ran. */
    | "file" | "web" | "search";
  label: string;
  detail: string;
  hash: string;
  size: string;
  visibility: "summary" | "provenance" | "full";
  content?: string;
  fields?: Array<{ label: string; value: string }>;
  withheldReason?: string;
};

export type Evidence = {
  stage: DeliveryStage;
  label: string;
  detail: string;
  complete: boolean;
};

export type Artifact = {
  id: string;
  kind: "code" | "document" | "image" | "link";
  name: string;
  detail: string;
  changedAt: string;
};

export type AgentTurn = {
  id: string;
  pubkey?: string;
  agentName: string;
  role: string;
  status: AgentStatus;
  statusLabel: string;
  operation: string;
  elapsed: string;
  lastActivity: string;
  model: string;
  branch: string;
  head: string;
  helperCount: number;
  activity: ActivityEvent[];
  liveText?: string;
  liveThought?: string;
  context: ContextSource[];
  evidence: Evidence[];
  artifacts: Artifact[];
};

export type Workstream = {
  id: string;
  title: string;
  phase: string;
  agents: AgentTurn[];
};

export type Channel = {
  id: string;
  name: string;
  description: string;
  workstreams: Workstream[];
};

export type TowerSnapshot = {
  generatedAt: string;
  viewerName: string;
  workspaceName: string;
  relayUrl?: string;
  source: "fixture" | "relay" | "runtime" | "unavailable";
  channels: Channel[];
  /**
   * Channel ids pinned in the workspace profile, in profile order. Absent on
   * fixture and unavailable snapshots, where no profile channels are editable.
   */
  configuredChannelIds?: string[];
};

export type DataConnection = {
  state: "fixture" | "connected" | "reconnecting" | "setup-required" | "error" | "onboarding";
  label: string;
  detail: string;
  /** Whether a temporary failure is safe for the UI to retry automatically. */
  retryable?: boolean;
};

export type SnapshotLoadResult = {
  snapshot: TowerSnapshot;
  connection: DataConnection;
};
