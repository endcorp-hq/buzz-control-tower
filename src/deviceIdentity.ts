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
