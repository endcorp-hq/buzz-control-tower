import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commands, loadProfile, validateProfile } from "./tower.mjs";

const CHANNEL = "0b7c0958-3f7f-48c8-af3f-31e549b10e31";
const SECOND_CHANNEL = "1da2b83b-c1e5-44b3-8a1c-546bf665933e";
const PUBKEY = "19215c80f8a71880f8c5738410d041e8afb2093bde1df8b4b691f23a50cb8b13";

let directory;
let path;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tower-test-"));
  path = join(directory, "nested", "workspace.json");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function initProfile() {
  return commands.init(path, [
    "--relay", "wss://buzz.example.org",
    "--workspace", "example",
    "--viewer", "Sam",
    "--channel", CHANNEL,
    "--channel-name", "general",
    "--author", `${PUBKEY}:Sam-Agent`,
  ]).profile;
}

describe("tower init", () => {
  it("creates a valid single-channel profile in one command", () => {
    const profile = initProfile();
    expect(profile.relayUrl).toBe("wss://buzz.example.org");
    expect(profile.channels).toHaveLength(1);
    expect(profile.channels[0].authors[0]).toEqual({ pubkey: PUBKEY, name: "Sam-Agent" });
    expect(loadProfile(path)).toEqual(profile);
  });

  it("refuses to overwrite without --force", () => {
    initProfile();
    expect(() => initProfile()).toThrow(/already exists/);
  });
});

describe("tower channel and collector commands", () => {
  it("adds channels, authors, collectors, and a local runtime", () => {
    initProfile();
    commands["add-channel"](path, [SECOND_CHANNEL, "--name", "ops", "--description", "Ops room"]);
    commands["add-author"](path, [SECOND_CHANNEL, "a".repeat(64), "--name", "Ops-Agent"]);
    commands["add-collector"](path, [
      "--channel", SECOND_CHANNEL,
      "--label", "Ops fleet",
      "--host", "control-tower@ops.example.ts.net",
      "--command", "/usr/local/bin/control-tower-fleet-export",
    ]);
    const { profile } = commands["set-local"](path, [
      "--channel", CHANNEL, "--pubkey", PUBKEY, "--name", "Sam-Agent",
    ]);

    expect(profile.channels.map((channel) => channel.name)).toEqual(["general", "ops"]);
    expect(profile.channels[1].authors[0].name).toBe("Ops-Agent");
    expect(profile.collectors[0].sshHost).toBe("control-tower@ops.example.ts.net");
    expect(profile.localRuntime.agentName).toBe("Sam-Agent");
    expect(existsSync(`${path}.bak`)).toBe(true);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  it("removing a channel also removes its collectors and local binding", () => {
    initProfile();
    commands["add-channel"](path, [SECOND_CHANNEL, "--name", "ops"]);
    commands["add-collector"](path, [
      "--channel", SECOND_CHANNEL,
      "--label", "Ops fleet",
      "--host", "control-tower@ops.example.ts.net",
      "--command", "/usr/local/bin/control-tower-fleet-export",
    ]);
    const { profile } = commands["remove-channel"](path, [SECOND_CHANNEL]);
    expect(profile.channels).toHaveLength(1);
    expect(profile.collectors).toHaveLength(0);
  });
});

describe("profile validation", () => {
  it("rejects hostile collector values before writing", () => {
    initProfile();
    expect(() => commands["add-collector"](path, [
      "--channel", CHANNEL,
      "--label", "evil",
      "--host", "-oProxyCommand=evil@host",
      "--command", "/usr/local/bin/export",
    ])).toThrow(/user@host/);
    expect(() => commands["add-collector"](path, [
      "--channel", CHANNEL,
      "--label", "evil",
      "--host", "user@host",
      "--command", "export; rm -rf /",
    ])).toThrow(/absolute path/);
    expect(() => commands["add-collector"](path, [
      "--channel", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "--label", "orphan",
      "--host", "user@host",
      "--command", "/usr/local/bin/export",
    ])).toThrow(/unlisted channel/);
  });

  it("rejects bad relay URLs, pubkeys, and duplicate channels", () => {
    const base = initProfile();
    expect(() => validateProfile({ ...base, relayUrl: "https://buzz.example.org" })).toThrow(/relayUrl/);
    expect(() => validateProfile({
      ...base,
      channels: [{ ...base.channels[0], authors: [{ pubkey: "nope" }] }],
    })).toThrow(/author pubkey/);
    expect(() => validateProfile({
      ...base,
      channels: [base.channels[0], base.channels[0]],
    })).toThrow(/duplicate channel/);
  });
});
