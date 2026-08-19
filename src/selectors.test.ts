import { describe, expect, it } from "vitest";
import { fixtureSnapshot } from "./fixtures";
import {
  agentsByStatus,
  allAgents,
  countWorkingAgents,
  findAgent,
  matchesAgentSearch,
} from "./selectors";

describe("control tower selectors", () => {
  it("flattens agents across channels and workstreams", () => {
    expect(allAgents(fixtureSnapshot)).toHaveLength(5);
  });

  it("finds a turn by its stable id", () => {
    expect(findAgent(fixtureSnapshot, "dany-loop")?.agentName).toBe("dany-mos-agent");
  });

  it("counts only actively working agents", () => {
    expect(countWorkingAgents(fixtureSnapshot)).toBe(2);
  });

  it("filters the graph by agent status", () => {
    expect(agentsByStatus(fixtureSnapshot, "working")).toHaveLength(2);
    expect(agentsByStatus(fixtureSnapshot, "blocked").map((agent) => agent.id)).toEqual([
      "mos-proxy",
    ]);
    expect(agentsByStatus(fixtureSnapshot, "all")).toHaveLength(5);
  });

  it("searches across agent, role, operation, and branch", () => {
    const agent = findAgent(fixtureSnapshot, "dany-loop");
    expect(agent).toBeDefined();
    expect(matchesAgentSearch(agent!, "topaz")).toBe(true);
    expect(matchesAgentSearch(agent!, "implementation")).toBe(true);
    expect(matchesAgentSearch(agent!, "unrelated")).toBe(false);
  });
});
