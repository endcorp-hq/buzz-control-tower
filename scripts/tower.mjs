#!/usr/bin/env node
// Deterministic workspace-profile editor for Buzz Control Tower.
//
// Every subcommand validates with the same rules as the native Rust loader
// and writes the profile atomically, so onboarding a relay, channel, or fleet
// collector is plain code execution — no app rebuild and no bespoke agent
// work. Mutations print the resulting profile as JSON.
//
// Channel agents are discovered live by the app from signed relay events
// (kind:39002 roster roles + kind:10100 agent profiles + kind:0 names), so
// `add-author` is an optional pin — pinned names win and pins survive even if
// the relay hides the roster. See docs/ONBOARDING.md.

import { mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

export const PROFILE_VERSION = 1;
export const DOCUMENT_VERSION = 2;
const MAX_WORKSPACES = 8;
const MAX_WORKSPACE_ID = 48;
const MAX_CHANNELS = 8;
const MAX_AUTHORS_PER_CHANNEL = 50;
const MAX_COLLECTORS = 4;
const MAX_NAME = 120;
const MAX_COMMAND = 256;

export function profilePath(env = process.env) {
  if (env.CONTROL_TOWER_WORKSPACE) return env.CONTROL_TOWER_WORKSPACE;
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw new Error("cannot locate the current user's home directory");
  return join(home, ".config", "control-tower", "workspace.json");
}

const isHexPubkey = (value) => typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
const isUuid = (value) =>
  typeof value === "string"
  && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
const validName = (value) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= MAX_NAME;
const validSshHost = (value) =>
  typeof value === "string" && /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(value)
  && !value.startsWith("-") && !value.split("@")[1].startsWith("-");
const validCommand = (value) =>
  typeof value === "string" && value.startsWith("/") && value.length <= MAX_COMMAND
  && /^[A-Za-z0-9/._-]+$/.test(value);
const validRelayUrl = (value) => {
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "wss:" || url.protocol === "ws:")
    && url.hostname !== "" && url.username === "" && url.password === ""
    && url.search === "" && url.hash === "";
};

const validWorkspaceId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_WORKSPACE_ID
  && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value);

// Stable, readable workspace id from the relay host, unique against `taken`.
// Mirrors the Rust `workspace_id_for`.
export function workspaceIdFor(relayUrl, taken = []) {
  let host = "";
  try {
    host = new URL(relayUrl).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const base = host.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_WORKSPACE_ID - 4) || "workspace";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export function validateProfile(profile) {
  if (!profile || typeof profile !== "object") throw new Error("profile must be an object");
  if (profile.version !== undefined && profile.version !== PROFILE_VERSION) {
    throw new Error(`workspace profile version must be ${PROFILE_VERSION}`);
  }
  if (!validName(profile.workspace) || !validName(profile.viewerName)) {
    throw new Error("workspace and viewer names must be 1 to 120 characters");
  }
  if (!validRelayUrl(profile.relayUrl)) {
    throw new Error("relayUrl must be a bare ws:// or wss:// URL without credentials or query");
  }
  if (!Array.isArray(profile.channels) || profile.channels.length < 1 || profile.channels.length > MAX_CHANNELS) {
    throw new Error(`profile must list 1 to ${MAX_CHANNELS} channels`);
  }
  const channelIds = new Set();
  for (const channel of profile.channels) {
    if (!isUuid(channel.id)) throw new Error(`channel id is not a UUID: ${channel.id}`);
    if (channelIds.has(channel.id)) throw new Error(`duplicate channel id: ${channel.id}`);
    channelIds.add(channel.id);
    if (!validName(channel.name)) throw new Error(`channel ${channel.id} has an invalid name`);
    if (channel.description !== undefined
      && (typeof channel.description !== "string" || channel.description.length > MAX_NAME * 2)) {
      throw new Error(`channel ${channel.id} has an invalid description`);
    }
    const authors = channel.authors ?? [];
    if (!Array.isArray(authors) || authors.length > MAX_AUTHORS_PER_CHANNEL) {
      throw new Error(`channel ${channel.id} exceeds ${MAX_AUTHORS_PER_CHANNEL} authors`);
    }
    const seen = new Set();
    for (const author of authors) {
      if (!isHexPubkey(author.pubkey)) throw new Error(`invalid author pubkey: ${author.pubkey}`);
      if (seen.has(author.pubkey.toLowerCase())) {
        throw new Error(`duplicate author pubkey: ${author.pubkey}`);
      }
      seen.add(author.pubkey.toLowerCase());
      if (author.name !== undefined && !validName(author.name)) {
        throw new Error(`invalid author name for ${author.pubkey}`);
      }
    }
  }
  const collectors = profile.collectors ?? [];
  if (!Array.isArray(collectors) || collectors.length > MAX_COLLECTORS) {
    throw new Error(`profile exceeds ${MAX_COLLECTORS} collectors`);
  }
  for (const collector of collectors) {
    if (!validName(collector.label)) throw new Error("collector label must be 1 to 120 characters");
    if (!channelIds.has(collector.channelId)) {
      throw new Error(`collector ${collector.label} is bound to an unlisted channel ${collector.channelId}`);
    }
    if (!validSshHost(collector.sshHost)) {
      throw new Error(`collector ${collector.label} has an invalid user@host`);
    }
    if (!validCommand(collector.command)) {
      throw new Error(`collector ${collector.label} command must be a fixed absolute path`);
    }
  }
  if (profile.localRuntime !== undefined) {
    const local = profile.localRuntime;
    if (!channelIds.has(local.channelId)) {
      throw new Error("local runtime is bound to an unlisted channel");
    }
    if (!isHexPubkey(local.agentPubkey) || !validName(local.agentName)) {
      throw new Error("local runtime has an invalid agent identity");
    }
  }
  return profile;
}

export function validateDocument(document) {
  if (!document || typeof document !== "object") throw new Error("document must be an object");
  if (document.version !== DOCUMENT_VERSION) {
    throw new Error(`workspace document version must be ${DOCUMENT_VERSION}`);
  }
  const workspaces = document.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length < 1 || workspaces.length > MAX_WORKSPACES) {
    throw new Error(`document must list 1 to ${MAX_WORKSPACES} workspaces`);
  }
  const ids = new Set();
  for (const workspace of workspaces) {
    if (!validWorkspaceId(workspace.id)) {
      throw new Error(`workspace id must be 1 to ${MAX_WORKSPACE_ID} lowercase letters, digits, or dashes: ${JSON.stringify(workspace.id)}`);
    }
    if (ids.has(workspace.id)) throw new Error(`duplicate workspace id: ${workspace.id}`);
    ids.add(workspace.id);
    try {
      validateProfile(workspace);
    } catch (error) {
      throw new Error(`workspace ${workspace.id}: ${error.message}`);
    }
  }
  if (!ids.has(document.activeWorkspace)) {
    throw new Error(`active workspace ${document.activeWorkspace} is not in the document`);
  }
  return document;
}

// Version-1 files hold one bare profile; wrap it as the only, active workspace.
function migrateProfile(profile) {
  validateProfile(profile);
  const { version: _version, ...entry } = profile;
  const id = entry.id || workspaceIdFor(entry.relayUrl);
  return { version: DOCUMENT_VERSION, activeWorkspace: id, workspaces: [{ id, ...entry }] };
}

export function loadDocument(path) {
  if (!existsSync(path)) {
    throw new Error(`no workspace profile at ${path}; run: tower init --relay <wss://relay> --workspace <name> --channel <uuid> --channel-name <name>`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return parsed?.version === DOCUMENT_VERSION ? validateDocument(parsed) : migrateProfile(parsed);
}

export function activeWorkspace(document) {
  return document.workspaces.find((workspace) => workspace.id === document.activeWorkspace);
}

/** The active workspace's profile (kept for callers that think in one relay). */
export function loadProfile(path) {
  return activeWorkspace(loadDocument(path));
}

export function saveDocument(path, document) {
  validateDocument(document);
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(document, null, 2)}\n`;
  const temp = `${path}.tmp`;
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeFileSync(temp, body);
  renameSync(temp, path);
  return document;
}

/** Upsert one workspace profile (by id, defaulting to the active one) into the document. */
export function saveProfile(path, profile) {
  const document = existsSync(path)
    ? loadDocument(path)
    : { version: DOCUMENT_VERSION, activeWorkspace: profile.id, workspaces: [] };
  const id = profile.id ?? document.activeWorkspace;
  const entry = { ...profile, id };
  delete entry.version;
  const index = document.workspaces.findIndex((workspace) => workspace.id === id);
  if (index === -1) document.workspaces.push(entry);
  else document.workspaces[index] = entry;
  saveDocument(path, document);
  return entry;
}

function summary(document) {
  return {
    activeWorkspace: document.activeWorkspace,
    workspaces: document.workspaces.map((workspace) => ({
      id: workspace.id,
      workspace: workspace.workspace,
      relayUrl: workspace.relayUrl,
      channelCount: workspace.channels.length,
      active: workspace.id === document.activeWorkspace,
    })),
  };
}

function newWorkspace(id, options) {
  return {
    id,
    workspace: options.workspace,
    viewerName: options.viewer ?? options.workspace,
    relayUrl: options.relay,
    channels: [{
      id: options.channel,
      name: options["channel-name"],
      description: options.description ?? "",
      authors: (options.author ?? []).map(parseAuthor),
    }],
    collectors: [],
  };
}

function parseAuthor(value) {
  const separator = value.indexOf(":");
  if (separator === -1) return { pubkey: value };
  return { pubkey: value.slice(0, separator), name: value.slice(separator + 1) };
}

function parseArgs(argv, spec) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (!(key in spec)) throw new Error(`unknown option --${key}`);
    if (spec[key] === "flag") {
      options[key] = true;
      continue;
    }
    index += 1;
    if (index >= argv.length) throw new Error(`--${key} requires a value`);
    if (spec[key] === "list") (options[key] ??= []).push(argv[index]);
    else options[key] = argv[index];
  }
  return { options, positional };
}

function required(options, keys) {
  for (const key of keys) {
    if (options[key] === undefined) throw new Error(`--${key} is required`);
  }
}

export const commands = {
  path(path) {
    return { path };
  },

  show(path) {
    const document = loadDocument(path);
    return { path, profile: activeWorkspace(document), ...summary(document) };
  },

  init(path, argv) {
    const { options } = parseArgs(argv, {
      relay: "value", workspace: "value", viewer: "value",
      channel: "value", "channel-name": "value", description: "value",
      author: "list", force: "flag", id: "value",
    });
    required(options, ["relay", "workspace", "channel", "channel-name"]);
    if (existsSync(path) && !options.force) {
      throw new Error(`a workspace profile already exists at ${path}; pass --force to replace it, or use add-workspace`);
    }
    const id = options.id ?? workspaceIdFor(options.relay);
    const document = { version: DOCUMENT_VERSION, activeWorkspace: id, workspaces: [newWorkspace(id, options)] };
    saveDocument(path, document);
    return { path, profile: activeWorkspace(document), ...summary(document) };
  },

  workspaces(path) {
    return { path, ...summary(loadDocument(path)) };
  },

  "add-workspace"(path, argv) {
    const { options } = parseArgs(argv, {
      relay: "value", workspace: "value", viewer: "value",
      channel: "value", "channel-name": "value", description: "value",
      author: "list", id: "value",
    });
    required(options, ["relay", "workspace", "channel", "channel-name"]);
    const document = loadDocument(path);
    const taken = document.workspaces.map((workspace) => workspace.id);
    const id = options.id ?? workspaceIdFor(options.relay, taken);
    if (taken.includes(id)) throw new Error(`workspace ${id} already exists`);
    document.workspaces.push(newWorkspace(id, options));
    document.activeWorkspace = id;
    saveDocument(path, document);
    return { path, profile: activeWorkspace(document), ...summary(document) };
  },

  use(path, argv) {
    const [id] = argv;
    if (!id) throw new Error("usage: tower use <workspace-id>");
    const document = loadDocument(path);
    if (!document.workspaces.some((workspace) => workspace.id === id)) {
      throw new Error(`workspace ${id} is not in the document`);
    }
    document.activeWorkspace = id;
    saveDocument(path, document);
    return { path, profile: activeWorkspace(document), ...summary(document) };
  },

  "remove-workspace"(path, argv) {
    const [id] = argv;
    if (!id) throw new Error("usage: tower remove-workspace <workspace-id>");
    const document = loadDocument(path);
    if (!document.workspaces.some((workspace) => workspace.id === id)) {
      throw new Error(`workspace ${id} is not in the document`);
    }
    if (document.workspaces.length === 1) {
      throw new Error("cannot remove the last workspace; the Tower must observe at least one relay");
    }
    document.workspaces = document.workspaces.filter((workspace) => workspace.id !== id);
    if (document.activeWorkspace === id) document.activeWorkspace = document.workspaces[0].id;
    saveDocument(path, document);
    return { path, profile: activeWorkspace(document), ...summary(document) };
  },

  "add-channel"(path, argv) {
    const { options, positional } = parseArgs(argv, {
      name: "value", description: "value", author: "list",
    });
    const [id] = positional;
    if (!id) throw new Error("usage: tower add-channel <channel-uuid> --name <name> [--description <text>] [--author <hex[:name]>]...");
    required(options, ["name"]);
    const profile = loadProfile(path);
    const channel = {
      id,
      name: options.name,
      description: options.description ?? "",
      authors: (options.author ?? []).map(parseAuthor),
    };
    const index = profile.channels.findIndex((existing) => existing.id === id);
    if (index === -1) profile.channels.push(channel);
    else profile.channels[index] = { ...channel, authors: channel.authors.length > 0 ? channel.authors : profile.channels[index].authors };
    return { path, profile: saveProfile(path, profile) };
  },

  "remove-channel"(path, argv) {
    const [id] = argv;
    if (!id) throw new Error("usage: tower remove-channel <channel-uuid>");
    const profile = loadProfile(path);
    if (!profile.channels.some((channel) => channel.id === id)) {
      throw new Error(`channel ${id} is not in the profile`);
    }
    profile.channels = profile.channels.filter((channel) => channel.id !== id);
    profile.collectors = (profile.collectors ?? []).filter((collector) => collector.channelId !== id);
    if (profile.localRuntime?.channelId === id) delete profile.localRuntime;
    return { path, profile: saveProfile(path, profile) };
  },

  "add-author"(path, argv) {
    const { options, positional } = parseArgs(argv, { name: "value" });
    const [channelId, pubkey] = positional;
    if (!channelId || !pubkey) {
      throw new Error("usage: tower add-author <channel-uuid> <pubkey-hex> [--name <display-name>]");
    }
    const profile = loadProfile(path);
    const channel = profile.channels.find((existing) => existing.id === channelId);
    if (!channel) throw new Error(`channel ${channelId} is not in the profile`);
    channel.authors = (channel.authors ?? []).filter((author) => author.pubkey !== pubkey);
    channel.authors.push(options.name ? { pubkey, name: options.name } : { pubkey });
    return { path, profile: saveProfile(path, profile) };
  },

  "add-collector"(path, argv) {
    const { options } = parseArgs(argv, {
      channel: "value", label: "value", host: "value", command: "value",
    });
    required(options, ["channel", "label", "host", "command"]);
    const profile = loadProfile(path);
    profile.collectors = (profile.collectors ?? []).filter((collector) => collector.label !== options.label);
    profile.collectors.push({
      label: options.label,
      channelId: options.channel,
      sshHost: options.host,
      command: options.command,
    });
    return { path, profile: saveProfile(path, profile) };
  },

  "remove-collector"(path, argv) {
    const { options } = parseArgs(argv, { label: "value" });
    required(options, ["label"]);
    const profile = loadProfile(path);
    const remaining = (profile.collectors ?? []).filter((collector) => collector.label !== options.label);
    if (remaining.length === (profile.collectors ?? []).length) {
      throw new Error(`collector ${options.label} is not in the profile`);
    }
    profile.collectors = remaining;
    return { path, profile: saveProfile(path, profile) };
  },

  "set-local"(path, argv) {
    const { options } = parseArgs(argv, { channel: "value", pubkey: "value", name: "value" });
    required(options, ["channel", "pubkey", "name"]);
    const profile = loadProfile(path);
    profile.localRuntime = {
      channelId: options.channel,
      agentPubkey: options.pubkey,
      agentName: options.name,
    };
    return { path, profile: saveProfile(path, profile) };
  },

  "clear-local"(path) {
    const profile = loadProfile(path);
    delete profile.localRuntime;
    return { path, profile: saveProfile(path, profile) };
  },

  "set-relay"(path, argv) {
    const [relayUrl] = argv;
    if (!relayUrl) throw new Error("usage: tower set-relay <wss://relay-host>");
    const profile = loadProfile(path);
    profile.relayUrl = relayUrl;
    return { path, profile: saveProfile(path, profile) };
  },
};

const USAGE = `Buzz Control Tower workspace commands (document: ~/.config/control-tower/workspace.json or $CONTROL_TOWER_WORKSPACE)

The document lists workspaces — one relay each — and which one is active. Channel,
author, collector, local-runtime and relay commands act on the active workspace.

  tower path
  tower show
  tower init --relay <wss://relay> --workspace <name> --channel <uuid> --channel-name <name> [--viewer <name>] [--description <text>] [--author <hex[:name]>]... [--id <workspace-id>] [--force]
  tower workspaces
  tower add-workspace --relay <wss://relay> --workspace <name> --channel <uuid> --channel-name <name> [--viewer <name>] [--description <text>] [--id <workspace-id>]
  tower use <workspace-id>
  tower remove-workspace <workspace-id>
  tower add-channel <channel-uuid> --name <name> [--description <text>] [--author <hex[:name]>]...
  tower remove-channel <channel-uuid>
  tower add-author <channel-uuid> <pubkey-hex> [--name <display-name>]   (optional pin; agents are auto-discovered)
  tower add-collector --channel <uuid> --label <label> --host <user@host> --command </absolute/exporter/path>
  tower remove-collector --label <label>
  tower set-local --channel <uuid> --pubkey <hex> --name <agent-name>
  tower clear-local
  tower set-relay <wss://relay-host>

Every mutation validates the full document and writes it atomically (previous
version kept at workspace.json.bak). Version-1 single-profile files are read
transparently and rewritten as a document on the first mutation. The running
app picks changes up on its next refresh — no rebuild.`;

export function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return 0;
  }
  const handler = commands[command];
  if (!handler) {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }
  try {
    console.log(JSON.stringify({ ok: true, command, ...handler(profilePath(), rest) }, null, 2));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, command, error: error.message }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
