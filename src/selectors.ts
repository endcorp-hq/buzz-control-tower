import type { AgentTurn, TowerSnapshot } from "./domain";

export function allAgents(snapshot: TowerSnapshot): AgentTurn[] {
  return snapshot.channels.flatMap((channel) =>
    channel.workstreams.flatMap((workstream) => workstream.agents),
  );
}

export function findAgent(
  snapshot: TowerSnapshot,
  agentId: string,
): AgentTurn | undefined {
  return allAgents(snapshot).find((agent) => agent.id === agentId);
}

export function countWorkingAgents(snapshot: TowerSnapshot): number {
  return allAgents(snapshot).filter((agent) => agent.status === "working").length;
}

export function agentsByStatus(
  snapshot: TowerSnapshot,
  status: AgentTurn["status"] | "all",
): AgentTurn[] {
  if (status === "all") return allAgents(snapshot);
  return allAgents(snapshot).filter((agent) => agent.status === status);
}

export function matchesAgentSearch(agent: AgentTurn, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [agent.agentName, agent.role, agent.operation, agent.branch].some((value) =>
    value.toLocaleLowerCase().includes(normalized),
  );
}
