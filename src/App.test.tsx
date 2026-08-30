// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ContextView, refreshDelayFor, shouldShowRelayRefresh } from "./App";
import type { ContextSource, DataConnection } from "./domain";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

  it("retries a transient relay error without restarting the app", () => {
    expect(refreshDelayFor({ ...connection("error"), retryable: true })).toBe(15_000);
  });

  it("does not poll a configuration error that needs operator action", () => {
    expect(refreshDelayFor({ ...connection("error"), retryable: false })).toBeUndefined();
  });

  it("does not automatically retry onboarding or authorization failures", () => {
    expect(refreshDelayFor(connection("onboarding"))).toBeUndefined();
    expect(refreshDelayFor(connection("setup-required"))).toBeUndefined();
  });

  it("keeps manual refresh available for a relay error even without a device key", () => {
    expect(shouldShowRelayRefresh(connection("error"), false)).toBe(true);
    expect(shouldShowRelayRefresh(connection("setup-required"), false)).toBe(false);
    expect(shouldShowRelayRefresh(connection("setup-required"), true)).toBe(true);
  });
});
