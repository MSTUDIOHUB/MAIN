import { resolveLegacyNexusModeKey, type NexusModeKey } from "./gameStudio/catalog";

export const MAIN_MODE_KEYS = ["main_mode", "game_studio", "image_studio"] as const;

export type MainModeKey = (typeof MAIN_MODE_KEYS)[number];

export function mapLegacyNexusModeToMainMode(value: string | null | undefined): MainModeKey {
  if (value === "image_studio") return "image_studio";
  const normalized = resolveLegacyNexusModeKey(value);
  return normalized === "nexus_game_studio" ? "game_studio" : "main_mode";
}

export function mapMainModeToLegacyNexusMode(mode: MainModeKey): NexusModeKey {
  return mode === "game_studio" ? "nexus_game_studio" : "nexus_general";
}

export function isGameStudioMainMode(mode: MainModeKey): boolean {
  return mode === "game_studio";
}

export function isImageStudioMainMode(mode: MainModeKey): boolean {
  return mode === "image_studio";
}
