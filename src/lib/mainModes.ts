import { resolveLegacyNexusModeKey, type NexusModeKey } from "./gameStudioCatalog";

export const MAIN_MODE_KEYS = ["main_mode", "task_center", "game_studio"] as const;

export type MainModeKey = (typeof MAIN_MODE_KEYS)[number];

export function mapLegacyNexusModeToMainMode(value: string | null | undefined): MainModeKey {
  if (value === "task_center") return "task_center";
  const normalized = resolveLegacyNexusModeKey(value);
  return normalized === "nexus_game_studio" ? "game_studio" : "main_mode";
}

export function mapMainModeToLegacyNexusMode(mode: MainModeKey): NexusModeKey {
  return mode === "game_studio" ? "nexus_game_studio" : "nexus_general";
}

export function isGameStudioMainMode(mode: MainModeKey): boolean {
  return mode === "game_studio";
}
