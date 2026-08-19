export type AgentStatus = "working" | "blocked" | "idle" | "complete";

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
};

export type ContextSource = {
  id: string;
  kind: "base" | "team" | "memory" | "thread" | "canvas" | "repository";
  label: string;
  detail: string;
  hash: string;
  size: string;
  visibility: "summary" | "provenance" | "full";
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
  source: "fixture" | "relay";
  channels: Channel[];
};
