import { describe, expect, it } from "vitest";
import { deriveManifest } from "./derivedContext";
import type { RichEntry } from "./dataSource";

let seq = 0;
function tool(
  title: string,
  rawInput: Record<string, string>,
  result?: string,
  at = "2026-09-05T18:00:00Z",
): RichEntry {
  seq += 1;
  return {
    id: `call-${seq}`,
    at,
    kind: "tool",
    title,
    detail: "",
    status: result === undefined ? "running" : "complete",
    parameters: Object.entries(rawInput).map(([label, value]) => ({ label, value })),
    result: result ?? null,
  };
}
function lifecycle(title: string): RichEntry {
  seq += 1;
  return { id: `life-${seq}`, at: "2026-09-05T17:59:00Z", kind: "lifecycle", title, detail: "", parameters: [], result: null };
}
// The store keeps entries newest-first; build fixtures oldest-first for readability.
const newestFirst = (entries: RichEntry[]) => [...entries].reverse();

describe("deriveManifest", () => {
  it("turns opencode-shaped reads, fetches and searches into context sources", () => {
    const manifest = deriveManifest(newestFirst([
      tool("README.md", { filePath: "/home/agent/repo/README.md", offset: "1", limit: "40" }, "# Repo\n..."),
      tool("fetch", { url: "https://docs.example.com/guide/getting-started?x=1", format: "markdown" }, "Getting started…"),
      tool("uv run", { pattern: "uv run", path: "/home/agent/repo", include: "*.md" }, "3 matches"),
      tool("*.ts", { pattern: "src/**/*.ts" }),
    ]));

    expect(manifest.artifacts).toEqual([]);
    expect(manifest.context.map((source) => [source.kind, source.label])).toEqual([
      ["search", "src/**/*.ts"],
      ["search", "uv run"],
      ["web", "docs.example.com/guide/getting-started"],
      ["file", "…/agent/repo/README.md"],
    ]);
    const read = manifest.context.at(-1)!;
    expect(read.visibility).toBe("summary");
    expect(read.content).toBe("# Repo\n...");
    expect(read.fields).toEqual([
      { label: "Path", value: "/home/agent/repo/README.md" },
      { label: "Range", value: "from line 1, 40 lines" },
    ]);
    // A search still running has no result to show, so the body is withheld.
    expect(manifest.context[0].visibility).toBe("provenance");
    expect(manifest.context[0].withheldReason).toContain("rich lane");
  });

  it("treats Claude Code-shaped write and edit inputs as artifacts, deduplicated by path", () => {
    const manifest = deriveManifest(newestFirst([
      tool("Read", { file_path: "/w/src/App.tsx" }, "..."),
      tool("Edit", { file_path: "/w/src/App.tsx", old_string: "a", new_string: "b" }, "ok", "2026-09-05T18:01:00Z"),
      tool("Write", { file_path: "/w/docs/NOTES.md", content: "# notes" }, "ok", "2026-09-05T18:02:00Z"),
      tool("Edit", { file_path: "/w/src/App.tsx", old_string: "b", new_string: "c" }, "ok", "2026-09-05T18:03:00Z"),
      tool("Write", { file_path: "/w/shot.png", content: "…" }, "ok"),
    ]), (iso) => iso.slice(11, 16));

    expect(manifest.artifacts.map((artifact) => [artifact.kind, artifact.name, artifact.detail, artifact.changedAt])).toEqual([
      ["image", "shot.png", "edited · Write", "18:00"],
      ["code", "App.tsx", "edited · Edit ×2", "18:03"],
      ["document", "NOTES.md", "edited · Write", "18:02"],
    ]);
    // The read of App.tsx is still context; the edits do not erase it.
    expect(manifest.context.map((source) => source.label)).toEqual(["/w/src/App.tsx"]);
  });

  it("recognises shell reads, redirect writes, git commits and Buzz publish verbs inside bash", () => {
    const manifest = deriveManifest(newestFirst([
      tool("bash", { command: "sed -n '1,40p' src/main.rs && cat docs/PLAN.md | head -20" }, "fn main() {}"),
      tool("bash", { command: "grep -rn 'deriveManifest' src/ | head" }, "src/x.ts:1"),
      tool("bash", { command: "cat > /tmp/body.md <<'EOF'\nhi\nEOF" }, ""),
      tool("bash", { command: "printf 'x' | tee OUTBOX/REPORT.md >/dev/null" }, ""),
      tool("bash", { command: "git add src && git commit -q -m 'fix: thing'" }, "[feat/x 0abc123] fix: thing\n 1 file changed"),
      tool("bash", { command: "git push -q origin feat/x" }, ""),
      tool("bash", { command: "buzz pr open --repo-id r --subject s --commit c --clone u --channel ch" }, '{"accepted":true,"link":"buzz://pr?id=86b8207c&owner=19&d=r"}'),
      tool("bash", { command: "buzz canvas set --channel ch --content -" }, "{}"),
      tool("bash", { command: "ls -la /tmp" }, ""),
    ]));

    expect(manifest.context.map((source) => [source.kind, source.label, source.detail])).toEqual([
      ["search", "/tmp", "Searched via ls"],
      ["search", "deriveManifest", "Searched via grep"],
      ["file", "docs/PLAN.md", "Read via cat"],
      ["file", "src/main.rs", "Read via sed"],
    ]);
    expect(manifest.artifacts.map((artifact) => [artifact.kind, artifact.name, artifact.detail])).toEqual([
      ["document", "Channel canvas updated", "buzz canvas set"],
      ["link", "Pull request opened", "buzz://pr?id=86b8207c&owner=19&d=r"],
      ["link", "Pushed", "git push origin feat/x"],
      ["code", "Commit 0abc123", "0abc123 on feat/x · fix: thing"],
      ["document", "REPORT.md", "written by shell"],
      ["document", "body.md", "written by shell"],
    ]);
  });

  it("scopes the manifest to the latest turn and ignores non-tool entries", () => {
    const manifest = deriveManifest(newestFirst([
      lifecycle("Turn started"),
      tool("Read", { file_path: "/old/turn.md" }, "…"),
      lifecycle("Turn completed"),
      lifecycle("Turn started"),
      tool("Read", { file_path: "/new/turn.md" }, "…"),
      { id: "m", at: "", kind: "message", title: "Prompt dispatched to agent", detail: "", parameters: [{ label: "path", value: "/not/a/tool" }], result: null },
    ]));
    expect(manifest.context.map((source) => source.fields?.[0].value)).toEqual(["/new/turn.md"]);
  });

  it("skips commands it does not understand instead of guessing", () => {
    const manifest = deriveManifest(newestFirst([
      tool("bash", { command: "npm test -- --run && cargo build --release" }, "ok"),
      tool("bash", { command: "echo hello > /dev/null" }, ""),
      tool("task", { description: "explore", prompt: "find callers" }, "done"),
    ]));
    expect(manifest).toEqual({ context: [], artifacts: [] });
  });
});
