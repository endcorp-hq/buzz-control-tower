// Auto-update: check the release feed on launch and on a periodic interval,
// download in the background, and let the user relaunch once the new version
// is staged. Failed checks surface as an error state instead of vanishing.
// No-ops outside a Tauri window (tests, plain browser dev), where the updater
// IPC is absent.
export type AppUpdateState =
  | { phase: "idle" }
  | { phase: "downloading"; version: string }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };

export const UPDATE_CHECK_INTERVAL_MS = 15 * 60_000;

export function updatesSupported(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function startAppUpdates(onState: (state: AppUpdateState) => void): () => void {
  if (!updatesSupported()) return () => undefined;
  let stopped = false;
  let staging = false;
  let staged = false;
  const attempt = async () => {
    if (stopped || staging || staged) return;
    staging = true;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update || stopped) return;
      onState({ phase: "downloading", version: update.version });
      await update.downloadAndInstall();
      staged = true;
      if (!stopped) onState({ phase: "ready", version: update.version });
    } catch (error) {
      if (!stopped) onState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      staging = false;
    }
  };
  void attempt();
  const timer = window.setInterval(() => void attempt(), UPDATE_CHECK_INTERVAL_MS);
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}

export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
