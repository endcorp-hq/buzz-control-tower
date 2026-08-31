// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelPicker, selectableChannels } from "./ChannelPicker";
import type { ChannelSummary } from "./dataSource";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, isTauri: () => true }));

const listed: ChannelSummary[] = [
  { id: "0b7c0958-3f7f-48c8-af3f-31e549b10e31", name: "buzz-control-tower", description: "Tower dev" },
  { id: "1da2b83b-c1e5-44b3-8a1c-546bf665933e", name: "mos-boston", description: "" },
  { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "relay-ops", description: "Ops" },
];

describe("selectableChannels", () => {
  it("hides channels that are already observed", () => {
    const remaining = selectableChannels(listed, [
      "0b7c0958-3f7f-48c8-af3f-31e549b10e31",
      "1da2b83b-c1e5-44b3-8a1c-546bf665933e",
    ]);
    expect(remaining.map((channel) => channel.name)).toEqual(["relay-ops"]);
  });

  it("is empty when every listed channel is observed", () => {
    expect(selectableChannels(listed, listed.map((channel) => channel.id))).toEqual([]);
  });
});

describe("channel picker", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    container = undefined;
    invokeMock.mockReset();
  });

  const flush = () => act(async () => {});

  const render = (onChanged: () => void = () => undefined) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const current = root;
    act(() => current.render(
      <ChannelPicker
        relayUrl="wss://relay.example"
        configuredChannelIds={["0b7c0958-3f7f-48c8-af3f-31e549b10e31"]}
        onChanged={onChanged}
      />,
    ));
    return container;
  };

  it("lists only unobserved channels and adds the chosen one to the profile", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_relay_channels") return Promise.resolve(listed);
      if (command === "add_workspace_channel") return Promise.resolve({ path: "p", profile: {} });
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    let changed = 0;
    const current = render(() => { changed += 1; });

    act(() => current.querySelector<HTMLButtonElement>("[aria-label='Add a channel']")?.click());
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("list_relay_channels", { relayUrl: "wss://relay.example" });

    const options = [...current.querySelectorAll<HTMLButtonElement>(".channel-picker-list button")];
    expect(options).toHaveLength(2);
    expect(options.some((option) => option.textContent?.includes("buzz-control-tower"))).toBe(false);

    const target = options.find((option) => option.textContent?.includes("relay-ops"));
    act(() => target?.click());
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("add_workspace_channel", {
      channelId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      channelName: "relay-ops",
      channelDescription: "Ops",
    });
    expect(changed).toBe(1);
    expect(current.querySelector(".channel-picker")).toBeNull();
  });

  it("surfaces a rejected add instead of closing silently", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_relay_channels") return Promise.resolve(listed);
      if (command === "add_workspace_channel") {
        return Promise.reject(new Error("profile must list 1 to 8 channels"));
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    let changed = 0;
    const current = render(() => { changed += 1; });

    act(() => current.querySelector<HTMLButtonElement>("[aria-label='Add a channel']")?.click());
    await flush();
    const option = [...current.querySelectorAll<HTMLButtonElement>(".channel-picker-list button")]
      .find((candidate) => candidate.textContent?.includes("relay-ops"));
    act(() => option?.click());
    await flush();

    expect(changed).toBe(0);
    expect(current.querySelector(".channel-picker-error")?.textContent)
      .toContain("1 to 8 channels");
    expect(current.querySelector(".channel-picker")).not.toBeNull();
  });
});
