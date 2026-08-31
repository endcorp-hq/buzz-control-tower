// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ContextView, refreshDelayFor, RELAY_RETRY_DELAYS_MS, RelayToast, RelayUnavailable, retriesAreExhausted, shouldShowRelayRefresh, viewerAvatarInitial, workspaceSubtitle } from "./App";
import type { ContextSource, DataConnection, TowerSnapshot } from "./domain";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("header identity", () => {
  it("uses the viewer's first visible character for the avatar", () => {
    expect(viewerAvatarInitial("Arjunpotter17")).toBe("A");
    expect(viewerAvatarInitial("  sam ")).toBe("S");
  });

  it("does not repeat a relay host that is already the workspace label", () => {
    expect(workspaceSubtitle("relay.endcorp.co", "wss://relay.endcorp.co")).toBe("relay.endcorp.co");
    expect(workspaceSubtitle("Control Tower", "wss://relay.endcorp.co"))
      .toBe("Control Tower · relay.endcorp.co");
  });
});

const sources: ContextSource[] = [
  {
    id: "trigger",
    kind: "thread",
    label: "Triggering Buzz turn",
    detail: "The human-authored request.",
    hash: "abcdef123456",
    size: "92 B",
    visibility: "summary",
    content: "Make context inspectable.",
    fields: [{ label: "Channel", value: "buzz-control-tower" }],
  },
  {
    id: "memory",
    kind: "memory",
    label: "Agent memory",
    detail: "Durable context was supplied.",
    hash: "123456abcdef",
    size: "4.2 KiB",
    visibility: "provenance",
    withheldReason: "Raw durable memory stays at the runtime source.",
  },
];

describe("inspectable context", () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    container?.remove();
    container = undefined;
  });

  it("opens safe content from a native context button and closes the drawer", () => {
    container = document.createElement("div");
    const current = container;
    document.body.append(current);
    const root = createRoot(current);

    act(() => root.render(<ContextView sources={sources} />));
    const cards = [...current.querySelectorAll<HTMLButtonElement>(".context-card")];
    expect(cards).toHaveLength(2);
    expect(cards[0].tagName).toBe("BUTTON");
    expect(current.querySelector("#context-detail")).toBeNull();

    act(() => cards[0].click());
    const detail = current.querySelector("#context-detail");
    expect(detail?.textContent).toContain("Make context inspectable.");
    expect(detail?.textContent).toContain("buzz-control-tower");
    expect(cards[0].getAttribute("aria-expanded")).toBe("true");

    act(() => current.querySelector<HTMLButtonElement>("[aria-label='Close context detail']")?.click());
    expect(current.querySelector("#context-detail")).toBeNull();
    act(() => root.unmount());
  });

  it("explains the source-side boundary for withheld context", () => {
    container = document.createElement("div");
    const current = container;
    document.body.append(current);
    const root = createRoot(current);
    act(() => root.render(<ContextView sources={sources} />));

    const cards = [...current.querySelectorAll<HTMLButtonElement>(".context-card")];
    act(() => cards[1].click());

    expect(current.querySelector("#context-detail")?.textContent).toContain(
      "Raw durable memory stays at the runtime source.",
    );
    expect(current.querySelector("#context-detail")?.textContent).not.toContain(
      "Make context inspectable.",
    );
    act(() => root.unmount());
  });
});

describe("relay refresh scheduling", () => {
  const connection = (state: DataConnection["state"]): DataConnection => ({
    state,
    label: "Relay",
    detail: "Test connection",
  });

  it("keeps connected relay data on the five-second refresh cadence", () => {
    expect(refreshDelayFor(connection("connected"))).toBe(5_000);
  });

  it("uses three quick bounded retries before surfacing an unavailable relay", () => {
    const unavailable = { ...connection("error"), retryable: true };
    expect(RELAY_RETRY_DELAYS_MS).toEqual([2_000, 5_000, 10_000]);
    expect(refreshDelayFor(unavailable, 0)).toBe(2_000);
    expect(refreshDelayFor(unavailable, 1)).toBe(5_000);
    expect(refreshDelayFor(unavailable, 2)).toBe(10_000);
    expect(retriesAreExhausted(unavailable, 2)).toBe(false);
    expect(retriesAreExhausted(unavailable, 3)).toBe(true);
  });

  it("does not poll a configuration error that needs operator action", () => {
    expect(refreshDelayFor({ ...connection("error"), retryable: false })).toBeUndefined();
  });

  it("does not automatically retry onboarding or authorization failures", () => {
    expect(refreshDelayFor(connection("onboarding"))).toBeUndefined();
    expect(refreshDelayFor(connection("setup-required"))).toBeUndefined();
  });

  it("only exposes manual refresh after all transient retries are exhausted", () => {
    const unavailable = { ...connection("error"), retryable: true };
    expect(shouldShowRelayRefresh(unavailable, 2)).toBe(false);
    expect(shouldShowRelayRefresh(unavailable, 3)).toBe(true);
    expect(shouldShowRelayRefresh({ ...connection("error"), retryable: false }, 0)).toBe(true);
  });

  it("announces reconnecting and recovery without replacing the work graph", () => {
    const current = document.createElement("div");
    document.body.append(current);
    const root = createRoot(current);

    act(() => root.render(<RelayToast state="reconnecting" />));
    expect(current.textContent).toContain("Reconnecting to relay");
    expect(current.textContent).not.toContain("dany-mos-agent");

    act(() => root.render(<RelayToast state="recovered" />));
    expect(current.textContent).toContain("Live updates restored");
    act(() => root.unmount());
    current.remove();
  });

  it("uses an honest unavailable screen and puts manual refresh only there", () => {
    const current = document.createElement("div");
    document.body.append(current);
    const root = createRoot(current);
    let refreshes = 0;
    const snapshot: TowerSnapshot = {
      generatedAt: "2026-08-30T00:00:00Z",
      viewerName: "Sam",
      workspaceName: "Example",
      relayUrl: "wss://relay.example",
      source: "unavailable",
      channels: [],
    };

    act(() => root.render(
      <RelayUnavailable
        snapshot={snapshot}
        connection={{ state: "error", label: "Relay unavailable", detail: "Connection timed out", retryable: true }}
        onRefresh={() => { refreshes += 1; }}
        deviceReady={false}
        onCopyDeviceKey={() => undefined}
        copyState="idle"
      />,
    ));
    expect(current.textContent).toContain("Relay unavailable");
    expect(current.textContent).toContain("relay.example");
    expect(current.textContent).not.toContain("dany-mos-agent");
    const refresh = [...current.querySelectorAll("button")].find((button) => button.textContent?.includes("Refresh now"));
    expect(refresh).toBeDefined();
    act(() => refresh?.click());
    expect(refreshes).toBe(1);
    act(() => root.unmount());
    current.remove();
  });

  it("lets an authorizing device re-check the relay without restarting", () => {
    const current = document.createElement("div");
    document.body.append(current);
    const root = createRoot(current);
    let refreshes = 0;
    const snapshot: TowerSnapshot = {
      generatedAt: "2026-08-30T00:00:00Z",
      viewerName: "Sam",
      workspaceName: "Example",
      relayUrl: "wss://relay.example",
      source: "unavailable",
      channels: [],
    };

    act(() => root.render(
      <RelayUnavailable
        snapshot={snapshot}
        connection={{ state: "setup-required", label: "Authorize device", detail: "Add this device identity to wss://relay.example to enable signed public activity.", retryable: false }}
        onRefresh={() => { refreshes += 1; }}
        deviceReady={true}
        onCopyDeviceKey={() => undefined}
        copyState="idle"
      />,
    ));
    expect(current.textContent).toContain("Authorize this device");
    const buttons = [...current.querySelectorAll("button")];
    expect(buttons.find((button) => button.textContent?.includes("Copy device key"))).toBeDefined();
    const recheck = buttons.find((button) => button.textContent?.includes("Check again"));
    expect(recheck).toBeDefined();
    act(() => recheck?.click());
    expect(refreshes).toBe(1);
    act(() => root.unmount());
    current.remove();
  });
});
