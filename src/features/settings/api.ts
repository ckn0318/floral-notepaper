import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "./types";

export function getConfig(): Promise<AppConfig> {
  return invoke("config_get");
}

export function saveConfig(config: AppConfig): Promise<AppConfig> {
  return invoke("config_save", { config });
}
