export const MAIN_MODE_KEYS = ["main_mode", "image_studio"] as const;

export type MainModeKey = (typeof MAIN_MODE_KEYS)[number];

export function mapLegacyNexusModeToMainMode(value: string | null | undefined): MainModeKey {
  if (value === "image_studio") return "image_studio";
  // Game Studio and every older Nexus/persona key now collapse into MAIN.
  // Keep this tolerant read boundary so old app and Session snapshots remain
  // loadable without allowing a removed mode back into new state.
  return "main_mode";
}

export function isImageStudioMainMode(mode: MainModeKey): boolean {
  return mode === "image_studio";
}
