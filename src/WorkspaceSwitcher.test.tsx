// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relayHostOf, WorkspaceSwitcher } from "./WorkspaceSwitcher";
import type { WorkspaceSummary } from "./domain";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const workspaces: WorkspaceSummary[] = [
  { id: "buzz-nilor-cool", workspace: "buzz.nilor.cool", relayUrl: "wss://buzz.nilor.cool", channelCount: 4, active: true },
  { id: "relay-moskunventures-com", workspace: "mv", relayUrl: "wss://relay.moskunventures.com", channelCount: 1, active: false },
];

describe("relayHostOf", () => {
  it("strips the scheme and trailing slash", () => {
    expect(relayHostOf("wss://buzz.nilor.cool/")).toBe("buzz.nilor.cool");
    expect(relayHostOf("ws://localhost:3000")).toBe("localhost:3000");
  });
});

describe("workspace switcher", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
  });

  function mount(props: Partial<Parameters<typeof WorkspaceSwitcher>[0]> = {}) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const handlers = { onSwitch: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn() };
    act(() => root!.render(
      <WorkspaceSwitcher
        workspaces={workspaces}
        activeWorkspaceId="buzz-nilor-cool"
        {...handlers}
        {...props}
      />,
    ));
    return { current: container, handlers };
  }

  it("shows the active workspace and lists every workspace with its relay host", () => {
    const { current } = mount();
    const button = current.querySelector<HTMLButtonElement>(".workspace-switcher-button")!;
    expect(button.textContent).toContain("buzz.nilor.cool");
    expect(current.querySelector(".workspace-switcher-menu")).toBeNull();

    act(() => button.click());
    const rows = [...current.querySelectorAll(".workspace-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].className).toContain("active");
    expect(rows[1].textContent).toContain("relay.moskunventures.com · 1 channel");
    expect(rows[0].querySelector("[role='option']")?.getAttribute("aria-selected")).toBe("true");
  });

  it("reports a switch for another workspace and ignores clicks on the active one", () => {
    const { current, handlers } = mount();
    act(() => current.querySelector<HTMLButtonElement>(".workspace-switcher-button")!.click());
    const options = [...current.querySelectorAll<HTMLButtonElement>("[role='option']")];
    act(() => options[0].click());
    expect(handlers.onSwitch).not.toHaveBeenCalled();
    act(() => current.querySelector<HTMLButtonElement>(".workspace-switcher-button")!.click());
    act(() => [...current.querySelectorAll<HTMLButtonElement>("[role='option']")][1].click());
    expect(handlers.onSwitch).toHaveBeenCalledWith("relay-moskunventures-com");
    // The menu closes after a choice.
    expect(current.querySelector(".workspace-switcher-menu")).toBeNull();
  });

  it("offers add and remove, but never removal of the last workspace", () => {
    const { current, handlers } = mount();
    act(() => current.querySelector<HTMLButtonElement>(".workspace-switcher-button")!.click());
    act(() => current.querySelector<HTMLButtonElement>("[aria-label='Stop observing mv']")!.click());
    expect(handlers.onRemove).toHaveBeenCalledWith("relay-moskunventures-com");
    act(() => current.querySelector<HTMLButtonElement>(".workspace-switcher-button")!.click());
    act(() => current.querySelector<HTMLButtonElement>(".workspace-add")!.click());
    expect(handlers.onAdd).toHaveBeenCalledTimes(1);

    act(() => root!.unmount());
    container!.remove();
    const single = mount({ workspaces: [workspaces[0]] });
    act(() => single.current.querySelector<HTMLButtonElement>(".workspace-switcher-button")!.click());
    expect(single.current.querySelector(".workspace-row-remove")).toBeNull();
    expect(single.current.querySelector(".workspace-add")).not.toBeNull();
  });
});
