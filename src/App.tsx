import {
  Activity,
  Archive,
  Boxes,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Image,
  Layers3,
  Link2,
  LockKeyhole,
  Radio,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { dataSource } from "./dataSource";
import {
  loadDeviceIdentity,
  type DeviceIdentityState,
} from "./deviceIdentity";
import type {
  ActivityEvent,
  AgentStatus,
  AgentTurn,
  Artifact,
  ContextSource,
  DeliveryStage,
  DataConnection,
  TowerSnapshot,
} from "./domain";
import { allAgents, countWorkingAgents, findAgent, matchesAgentSearch } from "./selectors";

type DetailTab = "live" | "context" | "evidence" | "artifacts";

const tabs: Array<{ id: DetailTab; label: string; icon: ComponentType<{ size?: number }> }> = [
  { id: "live", label: "Live", icon: Radio },
  { id: "context", label: "Context", icon: Braces },
  { id: "evidence", label: "Evidence", icon: ShieldCheck },
  { id: "artifacts", label: "Artifacts", icon: Archive },
];

const statusLabels: Record<AgentStatus, string> = {
  working: "Working",
  blocked: "Blocked",
  idle: "Idle",
  complete: "Complete",
};

function compactTime(isoTime: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(isoTime));
}

function StatusDot({ status, pulse = false }: { status: AgentStatus; pulse?: boolean }) {
  return <span className={`status-dot status-${status}${pulse ? " pulse" : ""}`} aria-hidden />;
}

function App() {
  const [snapshot, setSnapshot] = useState<TowerSnapshot>();
  const [connection, setConnection] = useState<DataConnection>({
    state: "fixture",
    label: "Fixture stream",
    detail: "Starting the companion data source.",
  });
  const [selectedId, setSelectedId] = useState("fizz-control");
  const [activeTab, setActiveTab] = useState<DetailTab>("live");
  const [search, setSearch] = useState("");
  const [expandedChannels, setExpandedChannels] = useState(() => new Set(["mos-boston", "buzz-control-tower"]));
  const [statusFilter, setStatusFilter] = useState<AgentStatus | "all">("all");
  const [deviceIdentity, setDeviceIdentity] = useState<DeviceIdentityState>({ status: "loading" });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      const result = await dataSource.loadSnapshot();
      if (cancelled) return;
      setSnapshot(result.snapshot);
      setConnection(result.connection);
      if (result.connection.state === "connected") {
        timer = window.setTimeout(refresh, 5_000);
      }
    };
    void refresh();
    void loadDeviceIdentity().then(setDeviceIdentity);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refreshVersion]);

  const agents = useMemo(() => (snapshot ? allAgents(snapshot) : []), [snapshot]);
  const selectedAgent = snapshot ? findAgent(snapshot, selectedId) : undefined;

  if (!snapshot || !selectedAgent) {
    return (
      <main className="loading-shell">
        <div className="loading-mark"><Sparkles size={22} /></div>
        <p>Assembling the work graph…</p>
      </main>
    );
  }

  const visibleAgentIds = new Set(
    agents
      .filter((agent) => statusFilter === "all" || agent.status === statusFilter)
      .filter((agent) => matchesAgentSearch(agent, search))
      .map((agent) => agent.id),
  );

  const selectAgent = (agentId: string) => {
    setSelectedId(agentId);
    setActiveTab("live");
  };

  const toggleChannel = (channelId: string) => {
    setExpandedChannels((current) => {
      const next = new Set(current);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  const copyDeviceKey = async () => {
    if (deviceIdentity.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(deviceIdentity.identity.pubkey);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1_500);
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><Zap size={19} fill="currentColor" /></div>
          <div>
            <div className="brand-name">Control Tower</div>
            <div className="workspace-name">{snapshot.workspaceName}</div>
          </div>
        </div>

        <div className="topbar-center">
          <span className="relay-indicator">
            <span className={`relay-pulse${deviceIdentity.status === "error" ? " relay-error" : ""}`} />
            {deviceIdentity.status === "ready" ? "Device ready" : deviceIdentity.status === "error" ? "Device error" : "Fixture ready"}
          </span>
          <span className="topbar-divider" />
          <span className={`source-state source-${connection.state}`}>{connection.label}</span>
          <span className="snapshot-time">Snapshot {compactTime(snapshot.generatedAt)}</span>
        </div>

        <div className="viewer-block">
          <div className="viewer-copy"><strong>{snapshot.viewerName}</strong><span>Owner view</span></div>
          <div className="avatar">LM</div>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-heading">
          <div>
            <span className="eyebrow">Workspace</span>
            <h2>Work graph</h2>
          </div>
          <div className="live-count"><span>{countWorkingAgents(snapshot)}</span> live</div>
        </div>

        <label className="search-box">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find agents or work…"
            aria-label="Find agents or work"
          />
          {search && <button onClick={() => setSearch("")} aria-label="Clear search"><X size={14} /></button>}
        </label>

        <div className="filter-row" aria-label="Filter agents by status">
          {(["all", "working", "blocked"] as const).map((filter) => (
            <button
              key={filter}
              className={statusFilter === filter ? "active" : ""}
              onClick={() => setStatusFilter(filter)}
            >
              {filter === "all" ? "All" : statusLabels[filter]}
            </button>
          ))}
        </div>

        <nav className="tree" aria-label="Channel work graph">
          {snapshot.channels.map((channel) => {
            const channelVisible = channel.workstreams.some((workstream) =>
              workstream.agents.some((agent) => visibleAgentIds.has(agent.id)),
            );
            if (!channelVisible) return null;
            const expanded = expandedChannels.has(channel.id);
            const workingCount = channel.workstreams.flatMap((workstream) => workstream.agents).filter((agent) => agent.status === "working").length;

            return (
              <div className="channel-node" key={channel.id}>
                <button className="channel-button" onClick={() => toggleChannel(channel.id)}>
                  {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  <span className="hash">#</span>
                  <span>{channel.name}</span>
                  {workingCount > 0 && <span className="tree-count">{workingCount}</span>}
                </button>

                {expanded && (
                  <div className="channel-children">
                    {channel.workstreams.map((workstream) => {
                      const visibleAgents = workstream.agents.filter((agent) => visibleAgentIds.has(agent.id));
                      if (!visibleAgents.length) return null;
                      return (
                        <div className="workstream-node" key={workstream.id}>
                          <div className="workstream-label">
                            <GitBranch size={13} />
                            <span>{workstream.title}</span>
                            <span className="phase-label">{workstream.phase}</span>
                          </div>
                          {visibleAgents.map((agent) => (
                            <button
                              key={agent.id}
                              className={`agent-row${selectedId === agent.id ? " selected" : ""}`}
                              onClick={() => selectAgent(agent.id)}
                            >
                              <StatusDot status={agent.status} pulse={agent.status === "working"} />
                              <span className="agent-row-copy">
                                <strong>{agent.agentName}</strong>
                                <span>{agent.operation}</span>
                              </span>
                              {agent.helperCount > 0 && <span className="helper-count"><Users size={11} />{agent.helperCount}</span>}
                            </button>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {visibleAgentIds.size === 0 && <div className="empty-tree">No matching work found.</div>}
        </nav>

        <div className="security-note">
          <LockKeyhole size={15} />
          <div>
            <strong>{deviceIdentity.status === "ready" ? `Device ${deviceIdentity.identity.fingerprint}` : "Security boundary"}</strong>
            <span>
              {deviceIdentity.status === "ready"
                ? connection.detail
                : deviceIdentity.status === "error"
                  ? "The OS keyring could not initialize the observer device."
                  : "Preparing a device-only identity for read-only relay access."}
            </span>
            {deviceIdentity.status === "ready" && connection.state === "setup-required" && (
              <div className="security-actions">
                <button className="copy-device-key" onClick={copyDeviceKey}>
                  {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy device key"}
                </button>
                <button className="copy-device-key" onClick={() => setRefreshVersion((version) => version + 1)}>
                  Retry relay
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <main className="workspace">
        <section className="agent-hero">
          <div className="agent-identity">
            <div className={`agent-glyph glyph-${selectedAgent.status}`}><Code2 size={23} /></div>
            <div>
              <div className="agent-meta"><span>{selectedAgent.role}</span><span>•</span><span>{selectedAgent.model}</span></div>
              <h1>{selectedAgent.agentName}</h1>
              <div className="operation-line"><StatusDot status={selectedAgent.status} pulse={selectedAgent.status === "working"} /><strong>{selectedAgent.statusLabel}</strong><span>{selectedAgent.operation}</span></div>
            </div>
          </div>

          <div className="hero-stats">
            <div><span>Elapsed</span><strong>{selectedAgent.elapsed}</strong></div>
            <div><span>Last activity</span><strong>{selectedAgent.lastActivity}</strong></div>
            <div><span>Nested helpers</span><strong>{selectedAgent.helperCount}</strong></div>
          </div>
        </section>

        <section className="provenance-strip">
          <div><GitBranch size={15} /><span>Branch</span><strong>{selectedAgent.branch}</strong></div>
          <div><GitCommitHorizontal size={15} /><span>HEAD</span><strong>{selectedAgent.head}</strong></div>
          <div className="visibility-pill"><ShieldCheck size={14} /> {snapshot.source === "relay" ? "Signed public events" : "Fixture data"}</div>
        </section>

        <div className="tab-bar" role="tablist">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const count = tab.id === "live" ? selectedAgent.activity.length : tab.id === "context" ? selectedAgent.context.length : tab.id === "evidence" ? selectedAgent.evidence.length : selectedAgent.artifacts.length;
            return (
              <button
                key={tab.id}
                className={activeTab === tab.id ? "active" : ""}
                onClick={() => setActiveTab(tab.id)}
                role="tab"
                aria-selected={activeTab === tab.id}
              >
                <Icon size={16} />{tab.label}<span>{count}</span>
              </button>
            );
          })}
        </div>

        <section className="detail-panel">
          {activeTab === "live" && <LiveView events={selectedAgent.activity} agent={selectedAgent} />}
          {activeTab === "context" && <ContextView sources={selectedAgent.context} />}
          {activeTab === "evidence" && <EvidenceView agent={selectedAgent} />}
          {activeTab === "artifacts" && <ArtifactsView artifacts={selectedAgent.artifacts} />}
        </section>
      </main>
    </div>
  );
}

function PanelHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="panel-heading">
      <div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
      <p>{description}</p>
    </div>
  );
}

function LiveView({ events, agent }: { events: ActivityEvent[]; agent: AgentTurn }) {
  return (
    <>
      <PanelHeading eyebrow="Turn stream" title="Live activity" description="A safe semantic view of this turn, including work performed by nested helpers." />
      {events.length ? (
        <div className="timeline">
          {events.map((event, index) => (
            <article className="timeline-item" key={event.id}>
              <div className={`timeline-icon event-${event.status ?? "complete"}`}>
                {event.status === "running" ? <Activity size={15} /> : event.status === "failed" ? <CircleDot size={15} /> : <Check size={15} />}
              </div>
              {index < events.length - 1 && <span className="timeline-line" />}
              <time>{event.at}</time>
              <div className="timeline-copy"><strong>{event.title}</strong><p>{event.detail}</p></div>
              <span className={`event-kind kind-${event.kind}`}>{event.kind}</span>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState icon={Clock3} title="No activity in this snapshot" text={`${agent.agentName} is not currently streaming a turn.`} />
      )}
    </>
  );
}

function ContextView({ sources }: { sources: ContextSource[] }) {
  return (
    <>
      <PanelHeading eyebrow="Provenance manifest" title="Supplied context" description="The source, version, and visibility of each context section supplied to the agent." />
      {sources.length ? (
        <div className="card-grid context-grid">
          {sources.map((source) => (
            <article className="info-card" key={source.id}>
              <div className="card-icon"><Layers3 size={17} /></div>
              <div className="card-main"><span className="card-kicker">{source.kind}</span><h3>{source.label}</h3><p>{source.detail}</p></div>
              <dl><div><dt>Hash</dt><dd>{source.hash}</dd></div><div><dt>Size</dt><dd>{source.size}</dd></div></dl>
              <span className={`visibility visibility-${source.visibility}`}>{source.visibility}</span>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState icon={Braces} title="No context manifest" text="This fixture does not include context provenance for the selected turn." />
      )}
    </>
  );
}

function EvidenceView({ agent }: { agent: AgentTurn }) {
  const completed = agent.evidence.filter((item) => item.complete).length;
  return (
    <>
      <PanelHeading eyebrow="Delivery chain" title="Evidence, not activity" description="The exact path from local work to a deployed result. Later stages never infer success from agent activity." />
      {agent.evidence.length ? (
        <>
          <div className="evidence-summary">
            <div className="evidence-score"><strong>{completed}</strong><span>of {agent.evidence.length} stages</span></div>
            <div className="progress-track"><span style={{ width: `${(completed / agent.evidence.length) * 100}%` }} /></div>
            <span>{completed === agent.evidence.length ? "Delivered" : "In progress"}</span>
          </div>
          <div className="delivery-chain">
            {agent.evidence.map((item, index) => (
              <article className={`delivery-stage${item.complete ? " complete" : ""}`} key={item.stage}>
                <div className="delivery-node">{item.complete ? <Check size={15} /> : index + 1}</div>
                <span className="stage-name">{stageName(item.stage)}</span>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>
        </>
      ) : (
        <EmptyState icon={ShieldCheck} title="No delivery evidence" text="No repository or deployment facts have been attached to this turn." />
      )}
    </>
  );
}

function stageName(stage: DeliveryStage) {
  return stage === "pr-open" ? "pull request" : stage;
}

const artifactIcons: Record<Artifact["kind"], ComponentType<{ size?: number }>> = {
  code: Code2,
  document: FileText,
  image: Image,
  link: Link2,
};

function ArtifactsView({ artifacts }: { artifacts: Artifact[] }) {
  return (
    <>
      <PanelHeading eyebrow="Turn outputs" title="Artifacts" description="Files, documents, images, and links attributed to this agent turn." />
      {artifacts.length ? (
        <div className="artifact-list">
          {artifacts.map((artifact) => {
            const Icon = artifactIcons[artifact.kind];
            return (
              <article key={artifact.id}>
                <div className="artifact-icon"><Icon size={18} /></div>
                <div><span>{artifact.kind}</span><strong>{artifact.name}</strong></div>
                <code>{artifact.detail}</code>
                <time>{artifact.changedAt}</time>
                <ChevronRight size={16} />
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={Boxes} title="No artifacts attached" text="This turn has not produced any indexed artifacts yet." />
      )}
    </>
  );
}

function EmptyState({ icon: Icon, title, text }: { icon: ComponentType<{ size?: number }>; title: string; text: string }) {
  return <div className="empty-state"><div><Icon size={23} /></div><h3>{title}</h3><p>{text}</p></div>;
}

export default App;
