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

export function validateProfile(profile) {
  if (!profile || typeof profile !== "object") throw new Error("profile must be an object");
  if (profile.version !== PROFILE_VERSION) {
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

export function loadProfile(path) {
  if (!existsSync(path)) {
    throw new Error(`no workspace profile at ${path}; run: tower init --relay <wss://relay> --workspace <name> --channel <uuid> --channel-name <name>`);
  }
  return validateProfile(JSON.parse(readFileSync(path, "utf8")));
}

export function saveProfile(path, profile) {
  validateProfile(profile);
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(profile, null, 2)}\n`;
  const temp = `${path}.tmp`;
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeFileSync(temp, body);
  renameSync(temp, path);
  return profile;
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
    return { path, profile: loadProfile(path) };
  },

  init(path, argv) {
    const { options } = parseArgs(argv, {
      relay: "value", workspace: "value", viewer: "value",
      channel: "value", "channel-name": "value", description: "value",
      author: "list", force: "flag",
    });
    required(options, ["relay", "workspace", "channel", "channel-name"]);
    if (existsSync(path) && !options.force) {
      throw new Error(`a workspace profile already exists at ${path}; pass --force to replace it`);
    }
    const profile = {
      version: PROFILE_VERSION,
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
    return { path, profile: saveProfile(path, profile) };
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

const USAGE = `Buzz Control Tower workspace commands (profile: ~/.config/control-tower/workspace.json or $CONTROL_TOWER_WORKSPACE)

  tower path
  tower show
  tower init --relay <wss://relay> --workspace <name> --channel <uuid> --channel-name <name> [--viewer <name>] [--description <text>] [--author <hex[:name]>]... [--force]
  tower add-channel <channel-uuid> --name <name> [--description <text>] [--author <hex[:name]>]...
  tower remove-channel <channel-uuid>
  tower add-author <channel-uuid> <pubkey-hex> [--name <display-name>]   (optional pin; agents are auto-discovered)
  tower add-collector --channel <uuid> --label <label> --host <user@host> --command </absolute/exporter/path>
  tower remove-collector --label <label>
  tower set-local --channel <uuid> --pubkey <hex> --name <agent-name>
  tower clear-local
  tower set-relay <wss://relay-host>

Every mutation validates the full profile and writes it atomically (previous
version kept at workspace.json.bak). The running app picks changes up on its
next refresh — no rebuild.`;

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
