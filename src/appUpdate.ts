// Auto-update: check the release feed on launch, download in the background,
// and let the user relaunch once the new version is staged. No-ops outside a
// Tauri window (tests, plain browser dev), where the updater IPC is absent.
export type AppUpdateState =
  | { phase: "idle" }
  | { phase: "downloading"; version: string }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };

export function updatesSupported(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function stageAppUpdate(onState: (state: AppUpdateState) => void): Promise<void> {
  if (!updatesSupported()) return;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return;
    onState({ phase: "downloading", version: update.version });
    await update.downloadAndInstall();
    onState({ phase: "ready", version: update.version });
  } catch (error) {
    onState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
