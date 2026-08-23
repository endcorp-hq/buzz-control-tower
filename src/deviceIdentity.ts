import { invoke, isTauri } from "@tauri-apps/api/core";

export type DeviceIdentity = {
  pubkey: string;
  fingerprint: string;
  storage: "system-keyring";
  created: boolean;
};

export type DeviceIdentityState =
  | { status: "loading" }
  | { status: "browser-preview" }
  | { status: "ready"; identity: DeviceIdentity }
  | { status: "error"; message: string };

/**
 * Replace this install's identity with a key the operator already owns
 * (nsec or 64-char hex). Throws on an unparseable key or a keyring failure
 * so callers can surface the error inline without flipping identity state.
 */
export async function importDeviceIdentity(secret: string): Promise<DeviceIdentity> {
  return invoke<DeviceIdentity>("import_device_identity", { secret });
}

export async function loadDeviceIdentity(): Promise<DeviceIdentityState> {
  if (!isTauri()) return { status: "browser-preview" };

  try {
    const identity = await invoke<DeviceIdentity>("get_device_identity");
    return { status: "ready", identity };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
