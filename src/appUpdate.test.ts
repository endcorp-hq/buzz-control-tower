// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAppUpdates, UPDATE_CHECK_INTERVAL_MS, type AppUpdateState } from "./appUpdate";

const checkMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));

function enableTauri() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  checkMock.mockReset();
  vi.useRealTimers();
});

describe("periodic app updates", () => {
  it("surfaces a failed update check instead of staying silent", async () => {
    enableTauri();
    checkMock.mockRejectedValue(new Error("release feed unreachable"));
    const states: AppUpdateState[] = [];
    const stop = startAppUpdates((state) => states.push(state));
    await vi.waitFor(() => expect(states).toEqual([{ phase: "error", message: "release feed unreachable" }]));
    stop();
  });

  it("re-checks on the interval and stages an update found after launch", async () => {
    vi.useFakeTimers();
    enableTauri();
    checkMock.mockResolvedValueOnce(null);
    const states: AppUpdateState[] = [];
    const stop = startAppUpdates((state) => states.push(state));
    await vi.advanceTimersByTimeAsync(0);
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(states).toEqual([]);

    checkMock.mockResolvedValueOnce({
      version: "9.9.9",
      downloadAndInstall: () => Promise.resolve(),
    });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(states).toEqual([
      { phase: "downloading", version: "9.9.9" },
      { phase: "ready", version: "9.9.9" },
    ]);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(checkMock).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does nothing after being stopped", async () => {
    vi.useFakeTimers();
    enableTauri();
    checkMock.mockResolvedValue(null);
    const states: AppUpdateState[] = [];
    const stop = startAppUpdates((state) => states.push(state));
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(states).toEqual([]);
  });
});
