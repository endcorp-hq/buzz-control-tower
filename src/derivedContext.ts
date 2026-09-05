import type { Artifact, ContextSource } from "./domain";
import type { RichEntry } from "./dataSource";

// Context and artifact manifests derived from the decrypted rich lane.
//
// The relay path has no collector on the agent host, so the only provenance
// available is the tool-call stream the harness already publishes. Every tool
// call carries its raw input (path, url, pattern, command…) and, once it
// finishes, a truncated result. That is enough to answer "what did this turn
// read?" and "what did it write?" without any harness or fleet change.
//
// Classification works on rawInput keys, not tool names, so opencode
// (filePath/oldString) and Claude Code (file_path/old_string) shapes both
// resolve. Bash commands get a light heuristic for the common read/write
// idioms and the Buzz CLI publish commands. Anything unrecognised is skipped —
// a wrong "artifact" is worse than a missing one.

export type DerivedManifest = {
  context: ContextSource[];
  artifacts: Artifact[];
};

const PATH_KEYS = ["filepath", "file_path", "path", "file", "notebook_path", "notebookpath"];
const WRITE_KEYS = ["content", "oldstring", "old_string", "newstring", "new_string", "edits", "new_source", "newsource"];
const URL_KEYS = ["url"];
const PATTERN_KEYS = ["pattern", "query", "regex"];
const COMMAND_KEYS = ["command", "cmd"];

const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "bat", "sed", "awk", "wc", "jq", "yq", "file", "stat"]);
const SEARCH_COMMANDS = new Set(["grep", "rg", "ag", "find", "fd", "ls", "tree"]);

const MAX_ITEMS = 40;
const MAX_DETAIL_CHARS = 96;

export function deriveManifest(
  entries: RichEntry[],
  formatTime: (iso: string) => string = (iso) => iso,
): DerivedManifest {
  const turn = latestTurn(entries);
  const context = new Map<string, ContextSource & { hits: number }>();
  const artifacts = new Map<string, Artifact & { hits: number }>();

  // Oldest first so "first read" / "last write" ordering is meaningful.
  for (const entry of [...turn].reverse()) {
    if (entry.kind !== "tool") continue;
    const params = paramMap(entry.parameters);
    const at = entry.at ? formatTime(entry.at) : "—";
    const url = firstValue(params, URL_KEYS);
    const path = firstValue(params, PATH_KEYS);
    const command = firstValue(params, COMMAND_KEYS);
    const pattern = firstValue(params, PATTERN_KEYS);
    const writes = WRITE_KEYS.some((key) => params.has(key));

    if (url) {
      addContext(context, {
        id: `web:${url}`,
        kind: "web",
        label: shortenUrl(url),
        detail: entry.title || "Fetched",
        fields: [{ label: "URL", value: url }],
      }, entry);
      continue;
    }
    if (path && writes) {
      addArtifact(artifacts, path, entry.title, at, "edited");
      continue;
    }
    if (path && !pattern) {
      addContext(context, {
        id: `file:${path}`,
        kind: "file",
        label: shortenPath(path),
        // opencode titles a read with the path itself; do not print it twice.
        detail: entry.title && !samePath(entry.title, path) ? entry.title : "Read",
        fields: rangeFields(params, path),
      }, entry);
      continue;
    }
    if (pattern) {
      const scope = path ?? params.get("include") ?? "";
      addContext(context, {
        id: `search:${pattern}:${scope}`,
        kind: "search",
        label: pattern,
        detail: scope ? `Searched ${shortenPath(scope)}` : entry.title || "Searched",
        fields: [{ label: "Pattern", value: pattern }, ...(scope ? [{ label: "Scope", value: scope }] : [])],
      }, entry);
      continue;
    }
    if (command) classifyCommand(command, entry, at, context, artifacts);
  }

  return {
    context: [...context.values()].reverse().slice(0, MAX_ITEMS).map(finishContext),
    artifacts: [...artifacts.values()].reverse().slice(0, MAX_ITEMS).map(finishArtifact),
  };
}

// Entries are newest-first. Scope the manifest to the most recent turn so a
// long-lived ring buffer does not blend several turns' reads into one list.
function latestTurn(entries: RichEntry[]): RichEntry[] {
  const start = entries.findIndex((entry) => entry.kind === "lifecycle" && entry.title === "Turn started");
  return start === -1 ? entries : entries.slice(0, start + 1);
}

function paramMap(parameters: RichEntry["parameters"]): Map<string, string> {
  const map = new Map<string, string>();
  for (const parameter of parameters ?? []) {
    const key = parameter.label.toLowerCase();
    if (!map.has(key) && parameter.value !== "") map.set(key, parameter.value);
  }
  return map;
}

function firstValue(params: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params.get(key);
    if (value) return value;
  }
  return undefined;
}

function rangeFields(params: Map<string, string>, path: string) {
  const fields = [{ label: "Path", value: path }];
  const offset = params.get("offset");
  const limit = params.get("limit");
  if (offset || limit) fields.push({ label: "Range", value: `${offset ? `from line ${offset}` : "from start"}${limit ? `, ${limit} lines` : ""}` });
  return fields;
}

function addContext(
  store: Map<string, ContextSource & { hits: number }>,
  source: Pick<ContextSource, "id" | "kind" | "label" | "detail" | "fields">,
  entry: RichEntry,
) {
  const existing = store.get(source.id);
  const result = entry.result?.trim();
  if (existing) {
    existing.hits += 1;
    if (result) existing.content = result;
    // Re-insert so the map keeps "most recently touched" order.
    store.delete(source.id);
    store.set(source.id, existing);
    return;
  }
  store.set(source.id, {
    ...source,
    hits: 1,
    hash: "—",
    size: "—",
    visibility: result ? "summary" : "provenance",
    content: result || undefined,
    withheldReason: result ? undefined : "Observed through the rich lane; the tool result had not arrived when this snapshot was taken.",
  });
}

function addArtifact(
  store: Map<string, Artifact & { hits: number }>,
  path: string,
  title: string,
  at: string,
  verb: string,
  kind: Artifact["kind"] = artifactKind(path),
  name: string = baseName(path),
) {
  const existing = store.get(path);
  if (existing) {
    existing.hits += 1;
    existing.changedAt = at;
    store.delete(path);
    store.set(path, existing);
    return;
  }
  store.set(path, {
    id: `artifact:${path}`,
    kind,
    name,
    detail: truncate(title && !samePath(title, path) ? `${verb} · ${title}` : verb, MAX_DETAIL_CHARS),
    changedAt: at,
    hits: 1,
  });
}

function finishContext({ hits, ...source }: ContextSource & { hits: number }): ContextSource {
  const size = source.content ? `${source.content.length.toLocaleString()} chars` : "—";
  return {
    ...source,
    size,
    detail: hits > 1 ? `${source.detail} · ×${hits}` : source.detail,
  };
}

function finishArtifact({ hits, ...artifact }: Artifact & { hits: number }): Artifact {
  return { ...artifact, detail: hits > 1 ? `${artifact.detail} ×${hits}` : artifact.detail };
}

// Bash is where the interesting side effects hide. Recognise the common read
// idioms, the shell redirect write, git commits/pushes, and the Buzz CLI
// publish verbs; skip everything else.
function classifyCommand(
  command: string,
  entry: RichEntry,
  at: string,
  context: Map<string, ContextSource & { hits: number }>,
  artifacts: Map<string, Artifact & { hits: number }>,
) {
  const segments = splitPipeline(command);
  for (const segment of segments) {
    const words = tokenize(segment);
    if (words.length === 0) continue;
    const program = programName(words);
    const argv = words.slice(words.indexOf(program) + 1);

    const redirect = redirectTarget(segment);
    if (redirect) {
      addArtifact(artifacts, redirect, "", at, "written by shell");
      continue;
    }
    if (program === "tee") {
      const target = argv.find((word) => !word.startsWith("-"));
      if (target) addArtifact(artifacts, target, "", at, "written by shell");
      continue;
    }
    if (program === "git") {
      const sub = argv.find((word) => !word.startsWith("-"));
      if (sub === "commit") {
        const summary = commitSummary(entry.result);
        addArtifact(artifacts, `commit:${summary ?? entry.id}`, "", at, summary ?? "git commit", "code", summary ? `Commit ${summary.slice(0, 7)}` : "Commit");
      } else if (sub === "push") {
        const target = argv.slice(argv.indexOf(sub) + 1).filter((w) => !w.startsWith("-")).join(" ");
        addArtifact(artifacts, `push:${target || entry.id}`, "", at, target ? `git push ${target}` : "git push", "link", "Pushed");
      }
      continue;
    }
    if (program === "buzz" || program === "gh") {
      publishArtifact(program, argv, entry, at, artifacts);
      continue;
    }
    if (READ_COMMANDS.has(program)) {
      for (const file of fileArgs(program, argv)) {
        addContext(context, {
          id: `file:${file}`,
          kind: "file",
          label: shortenPath(file),
          detail: `Read via ${program}`,
          fields: [{ label: "Path", value: file }],
        }, entry);
      }
      continue;
    }
    if (SEARCH_COMMANDS.has(program)) {
      const positional = argv.filter((word) => !word.startsWith("-"));
      const pattern = program === "find" || program === "fd" || program === "ls" || program === "tree" ? positional.join(" ") : positional[0];
      if (!pattern) continue;
      addContext(context, {
        id: `search:${program}:${pattern}`,
        kind: "search",
        label: pattern,
        detail: `Searched via ${program}`,
        fields: [{ label: "Command", value: truncate(segment, 200) }],
      }, entry);
    }
  }
}

function publishArtifact(
  program: string,
  argv: string[],
  entry: RichEntry,
  at: string,
  artifacts: Map<string, Artifact & { hits: number }>,
) {
  const positional = argv.filter((word) => !word.startsWith("-"));
  const [group, verb] = positional;
  const link = extractLink(entry.result);
  const push = (id: string, kind: Artifact["kind"], name: string, detail: string) => {
    const existing = artifacts.get(id);
    if (existing) { existing.changedAt = at; existing.hits += 1; artifacts.delete(id); artifacts.set(id, existing); return; }
    artifacts.set(id, { id, kind, name, detail, changedAt: at, hits: 1 });
  };
  if (program === "buzz") {
    if (group === "pr" && verb === "open") push(`pr:${link ?? entry.id}`, "link", "Pull request opened", link ?? "buzz pr open");
    else if (group === "issues" && verb === "create") push(`issue:${link ?? entry.id}`, "link", "Issue created", link ?? "buzz issues create");
    else if (group === "canvas" && verb === "set") push("canvas", "document", "Channel canvas updated", "buzz canvas set");
    else if (group === "upload") push(`upload:${link ?? entry.id}`, "image", "Media uploaded", link ?? "buzz upload");
    else if (group === "messages" && verb === "send") {
      const file = optionValue(argv, "--file");
      if (file) push(`upload:${file}`, artifactKind(file), baseName(file), `attached via buzz messages send`);
    }
  } else if (program === "gh" && group === "pr" && verb === "create") {
    push(`pr:${link ?? entry.id}`, "link", "Pull request opened", link ?? "gh pr create");
  }
}

// ---- helpers ---------------------------------------------------------------

function splitPipeline(command: string): string[] {
  // Split on unquoted |, ||, &&, ; and newlines. Quotes are honoured so a
  // pipe inside a grep pattern does not start a new segment.
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === "|" || ch === ";" || ch === "\n" || (ch === "&" && command[i + 1] === "&")) {
      if (ch === "&") i += 1;
      if (ch === "|" && command[i + 1] === "|") i += 1;
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((segment) => segment.trim()).filter(Boolean);
}

function tokenize(segment: string): string[] {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(segment)) !== null) {
    words.push(match[1] ?? match[2] ?? match[3]);
  }
  return words;
}

// Skip env assignments and sudo/nohup/time prefixes: `FOO=1 sudo cat x` → cat.
function programName(words: string[]): string {
  const wrappers = new Set(["sudo", "nohup", "time", "env", "command", "exec", "xargs"]);
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (wrappers.has(word) || word.startsWith("-")) continue;
    return word.split("/").pop() ?? word;
  }
  return words[0];
}

function redirectTarget(segment: string): string | undefined {
  const match = /(?:^|[^<>&|\d])>>?\s*([^\s|&;]+)/.exec(segment);
  if (!match) return undefined;
  const target = match[1].replace(/^['"]|['"]$/g, "");
  if (target === "/dev/null" || target.startsWith("&") || target.startsWith("/dev/")) return undefined;
  return target;
}

function fileArgs(program: string, argv: string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (word.startsWith("-")) {
      // Options that take a value: sed -n '1,20p' file / head -n 20 file.
      if (/^-(n|e|f|c|F|d)$/.test(word) && program !== "sed") i += 1;
      continue;
    }
    // sed scripts: line ranges (1,20p), substitutions (s/a/b/), addresses (/x/p).
    if (program === "sed" && (/^\d/.test(word) || word.startsWith("s/") || word.startsWith("/") || word === "p")) continue;
    if (program === "awk" && files.length === 0 && (word.includes("{") || word.includes("$"))) continue;
    if (program === "jq" && files.length === 0 && (word.startsWith(".") || word.startsWith("[") || word.startsWith("-"))) continue;
    if (word === "-" || word.startsWith("<<")) continue;
    if (/^[A-Za-z0-9_./~$\-][^\s'"]*$/.test(word) && (word.includes("/") || word.includes("."))) files.push(word);
  }
  return files;
}

function optionValue(argv: string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  return index === -1 ? undefined : argv[index + 1];
}

function commitSummary(result: string | null | undefined): string | undefined {
  if (!result) return undefined;
  const match = /\[([^\]\s]+)\s+(?:\(root-commit\)\s+)?([0-9a-f]{7,40})\]\s*(.*)/.exec(result);
  return match ? `${match[2].slice(0, 7)} on ${match[1]}${match[3] ? ` · ${match[3].trim()}` : ""}` : undefined;
}

function extractLink(result: string | null | undefined): string | undefined {
  if (!result) return undefined;
  const match = /(buzz:\/\/[^\s"'\\]+|https?:\/\/[^\s"'\\]+)/.exec(result);
  return match?.[1];
}

function artifactKind(path: string): Artifact["kind"] {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (["md", "txt", "pdf", "doc", "docx", "rst"].includes(ext)) return "document";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  return "code";
}

function samePath(title: string, path: string): boolean {
  const cleaned = title.trim();
  return cleaned === path || path.endsWith(`/${cleaned}`) || cleaned === baseName(path);
}

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function shortenPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const trail = parsed.pathname.length > 40 ? `${parsed.pathname.slice(0, 37)}…` : parsed.pathname;
    return `${parsed.host}${trail === "/" ? "" : trail}`;
  } catch {
    return truncate(url, 60);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
