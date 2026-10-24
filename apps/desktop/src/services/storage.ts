import { invoke } from "@tauri-apps/api/core";

export type StorageMode = "local" | "cloud";

export type StorageConfig = {
  version: number;
  mode: StorageMode;
  apiBaseUrl: string;
  onboardingComplete: boolean;
};

/// Fallback para navegador/E2E sin núcleo: mismo default que Rust.
export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  version: 1,
  mode: "local",
  apiBaseUrl: "http://127.0.0.1:8787",
  onboardingComplete: false,
};

export function loadStorageConfig(): Promise<StorageConfig> {
  return invoke<StorageConfig>("storage_config_get");
}

export function saveStorageConfig(
  mode: StorageMode,
  apiBaseUrl: string,
): Promise<StorageConfig> {
  return invoke<StorageConfig>("storage_config_set", { mode, apiBaseUrl });
}
