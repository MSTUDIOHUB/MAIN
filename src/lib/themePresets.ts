export type ResolvedThemeMode = "light" | "dark" | "black";
export type ThemeVariantKind = "light" | "dark";

export interface ThemePresetDefinition {
  id: string;
  nameZh: string;
  nameEn: string;
  background: string;
  foreground: string;
  accent: string;
}

export interface ThemeVariantConfig {
  preset: string;
  background: string;
  foreground: string;
  accent: string;
}

export interface BlackThemeConfig {
  accent: string;
}

export interface ThemeAccentTokens {
  accent: string;
  hover: string;
  light: string;
  subtle: string;
  subtleBorder: string;
  contrast: string;
  name: string;
}

export interface ThemeSurfaceScale {
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  surfaceBorder: string;
  surfaceBorderSoft: string;
  text: string;
  textStrong: string;
  textMuted: string;
  textSubtle: string;
  scrollbar: string;
  scrollbarHover: string;
}

export interface DerivedCodeSurfaceTone {
  border: string;
  background: string;
  headerBackground: string;
  text: string;
}

export interface DerivedExpandedModalTone {
  overlay: string;
  modalBorder: string;
  modalBackground: string;
  modalShadow: string;
  headerBorder: string;
  titleText: string;
  buttonBorder: string;
  buttonBackground: string;
  buttonText: string;
  bodyBackground: string;
}

export interface DerivedTerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface DerivedThemePalette {
  effectiveMode: ResolvedThemeMode;
  preset: string;
  background: string;
  foreground: string;
  surfaces: ThemeSurfaceScale;
  accentTokens: ThemeAccentTokens;
  codeSurface: DerivedCodeSurfaceTone;
  expandedModalTone: DerivedExpandedModalTone;
  mermaidThemeVariables: Record<string, string | boolean>;
  terminalTheme: DerivedTerminalTheme;
  signature: string;
}

export const CLASSIC_ACCENT_SWATCHES = {
  blue: {
    accent: "#007ACC",
    hover: "#005F9E",
    light: "#3B82F6",
    subtle: "rgba(0,122,204,0.15)",
    subtleBorder: "rgba(0,122,204,0.3)",
    contrast: "#ffffff",
    name: "VS Code Blue",
  },
  purple: {
    accent: "#9333EA",
    hover: "#7E22CE",
    light: "#A855F7",
    subtle: "rgba(147,51,234,0.15)",
    subtleBorder: "rgba(147,51,234,0.3)",
    contrast: "#ffffff",
    name: "Amethyst",
  },
  green: {
    accent: "#059669",
    hover: "#047857",
    light: "#10B981",
    subtle: "rgba(5,150,105,0.15)",
    subtleBorder: "rgba(5,150,105,0.3)",
    contrast: "#ffffff",
    name: "Matrix Green",
  },
  yellow: {
    accent: "#CA8A04",
    hover: "#A16207",
    light: "#EAB308",
    subtle: "rgba(202,138,4,0.15)",
    subtleBorder: "rgba(202,138,4,0.3)",
    contrast: "#111827",
    name: "Sublime Gold",
  },
  rose: {
    accent: "#E11D48",
    hover: "#BE123C",
    light: "#FB7185",
    subtle: "rgba(225,29,72,0.15)",
    subtleBorder: "rgba(225,29,72,0.3)",
    contrast: "#ffffff",
    name: "Ruby Red",
  },
  hermesOrange: {
    accent: "#F37021",
    hover: "#D85F16",
    light: "#FB923C",
    subtle: "rgba(243,112,33,0.15)",
    subtleBorder: "rgba(243,112,33,0.32)",
    contrast: "#111827",
    name: "Hermes Orange",
  },
  tiffanyBlue: {
    accent: "#81D8D0",
    hover: "#5EC7BD",
    light: "#A8EEE8",
    subtle: "rgba(129,216,208,0.16)",
    subtleBorder: "rgba(129,216,208,0.34)",
    contrast: "#063433",
    name: "Tiffany Blue",
  },
} as const;

export type ClassicAccentKey = keyof typeof CLASSIC_ACCENT_SWATCHES;
export const CLASSIC_ACCENT_KEYS = Object.keys(CLASSIC_ACCENT_SWATCHES) as ClassicAccentKey[];

export const LIGHT_THEME_PRESETS: readonly ThemePresetDefinition[] = [
  {
    id: "default",
    nameZh: "MAIN 默认",
    nameEn: "MAIN Default",
    background: "#F4F4F5",
    foreground: "#18181B",
    accent: "#9333EA",
  },
  {
    id: "catppuccin",
    nameZh: "Catppuccin Latte",
    nameEn: "Catppuccin Latte",
    background: "#EAECF0",
    foreground: "#4C4F69",
    accent: "#8839EF",
  },
  {
    id: "warm-paper",
    nameZh: "暖纸米白",
    nameEn: "Warm Paper",
    background: "#F5F2EB",
    foreground: "#2D2A26",
    accent: "#C96442",
  },
  {
    id: "cool-slate",
    nameZh: "极简冷灰",
    nameEn: "Cool Slate",
    background: "#F3F4F6",
    foreground: "#111827",
    accent: "#5E6AD2",
  },
  {
    id: "github-light",
    nameZh: "GitHub Light",
    nameEn: "GitHub Light",
    background: "#F6F8FA",
    foreground: "#1F2328",
    accent: "#0969DA",
  },
  {
    id: "nord-snow",
    nameZh: "清冷雾白",
    nameEn: "Nord Snow",
    background: "#ECEFF4",
    foreground: "#2E3440",
    accent: "#5E81AC",
  },
];

export const DARK_THEME_PRESETS: readonly ThemePresetDefinition[] = [
  {
    id: "default",
    nameZh: "MAIN 默认",
    nameEn: "MAIN Default",
    background: "#111112",
    foreground: "#E4E4E7",
    accent: "#9333EA",
  },
  {
    id: "catppuccin",
    nameZh: "Catppuccin Mocha",
    nameEn: "Catppuccin Mocha",
    background: "#1E1E2E",
    foreground: "#CDD6F4",
    accent: "#CBA6F7",
  },
  {
    id: "warm-charcoal",
    nameZh: "暖炭深灰",
    nameEn: "Warm Charcoal",
    background: "#1C1917",
    foreground: "#E7E5E4",
    accent: "#D97757",
  },
  {
    id: "cool-graphite",
    nameZh: "极简冷灰",
    nameEn: "Cool Graphite",
    background: "#14151A",
    foreground: "#E2E4E9",
    accent: "#5E6AD2",
  },
  {
    id: "github-dark",
    nameZh: "GitHub Dark",
    nameEn: "GitHub Dark",
    background: "#0D1117",
    foreground: "#E6EDF3",
    accent: "#2F81F7",
  },
  {
    id: "nord-polar",
    nameZh: "北欧深灰",
    nameEn: "Nord Polar",
    background: "#2E3440",
    foreground: "#ECEFF4",
    accent: "#88C0D0",
  },
];

export function isValidHexColor(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed);
}

export function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback.toUpperCase();
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return fallback.toUpperCase();
}

function parseHexRgb(hex: string): [number, number, number] {
  const normalized = normalizeHexColor(hex, "#000000");
  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16),
  ];
}

function formatHexRgb(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

export function mixHex(hexA: string, hexB: string, weightB: number): string {
  const w = Math.max(0, Math.min(1, weightB));
  const [r1, g1, b1] = parseHexRgb(hexA);
  const [r2, g2, b2] = parseHexRgb(hexB);
  return formatHexRgb(
    r1 + (r2 - r1) * w,
    g1 + (g2 - g1) * w,
    b1 + (b2 - b1) * w,
  );
}

export function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHexRgb(hex);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r},${g},${b},${a})`;
}

export function getRelativeLuminance(hex: string): number {
  const [r, g, b] = parseHexRgb(hex).map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function resolveEffectiveThemeMode(
  themeMode: unknown,
  systemPrefersLight = false,
): ResolvedThemeMode {
  if (themeMode === "system") {
    return systemPrefersLight ? "light" : "dark";
  }
  if (themeMode === "light" || themeMode === "dark" || themeMode === "black") {
    return themeMode;
  }
  return "dark";
}

export function getThemePresetsForVariant(kind: ThemeVariantKind): readonly ThemePresetDefinition[] {
  return kind === "light" ? LIGHT_THEME_PRESETS : DARK_THEME_PRESETS;
}

export function findThemePreset(
  kind: ThemeVariantKind,
  presetId: string | undefined,
): ThemePresetDefinition | undefined {
  if (!presetId) return undefined;
  return getThemePresetsForVariant(kind).find((preset) => preset.id === presetId);
}

export function resolveMatchingPresetId(
  kind: ThemeVariantKind,
  colors: { background: string; foreground: string; accent: string },
): string {
  const bg = normalizeHexColor(colors.background, "#000000");
  const fg = normalizeHexColor(colors.foreground, "#FFFFFF");
  const ac = normalizeHexColor(colors.accent, "#9333EA");
  const match = getThemePresetsForVariant(kind).find(
    (preset) =>
      preset.background.toUpperCase() === bg &&
      preset.foreground.toUpperCase() === fg &&
      preset.accent.toUpperCase() === ac,
  );
  return match ? match.id : "custom";
}

export function getDefaultThemeVariantConfig(
  kind: ThemeVariantKind,
  accentOverride?: string,
): ThemeVariantConfig {
  const base = getThemePresetsForVariant(kind)[0];
  const accent = accentOverride
    ? normalizeHexColor(accentOverride, base.accent)
    : base.accent;
  return {
    preset: resolveMatchingPresetId(kind, {
      background: base.background,
      foreground: base.foreground,
      accent,
    }),
    background: base.background,
    foreground: base.foreground,
    accent,
  };
}

export function getDefaultBlackThemeConfig(accentOverride?: string): BlackThemeConfig {
  return {
    accent: normalizeHexColor(accentOverride, "#9333EA"),
  };
}

export function findMatchingClassicAccentKey(accentHex: string): ClassicAccentKey | null {
  const target = normalizeHexColor(accentHex, "");
  for (const key of CLASSIC_ACCENT_KEYS) {
    if (CLASSIC_ACCENT_SWATCHES[key].accent.toUpperCase() === target) {
      return key;
    }
  }
  return null;
}

export function normalizeThemeVariantConfig(
  kind: ThemeVariantKind,
  raw: unknown,
  fallbackAccent?: string,
): ThemeVariantConfig {
  const defaults = getDefaultThemeVariantConfig(kind, fallbackAccent);
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const obj = raw as Record<string, unknown>;
  const presetMatch = typeof obj.preset === "string" ? findThemePreset(kind, obj.preset) : undefined;
  const fallbackBg = presetMatch?.background ?? defaults.background;
  const fallbackFg = presetMatch?.foreground ?? defaults.foreground;
  const fallbackAc = presetMatch?.accent ?? defaults.accent;

  const background = normalizeHexColor(obj.background, fallbackBg);
  const foreground = normalizeHexColor(obj.foreground, fallbackFg);
  const accent = normalizeHexColor(obj.accent, fallbackAc);
  return {
    preset: resolveMatchingPresetId(kind, { background, foreground, accent }),
    background,
    foreground,
    accent,
  };
}

export function normalizeBlackThemeConfig(
  raw: unknown,
  fallbackAccent?: string,
): BlackThemeConfig {
  const defaults = getDefaultBlackThemeConfig(fallbackAccent);
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const obj = raw as Record<string, unknown>;
  return {
    accent: normalizeHexColor(obj.accent, defaults.accent),
  };
}

export function normalizeThemeConfigFields(
  persistedConfig: Record<string, unknown> | null | undefined,
  legacyThemeKey?: unknown,
): {
  lightTheme: ThemeVariantConfig;
  darkTheme: ThemeVariantConfig;
  blackTheme: BlackThemeConfig;
} {
  const rawKey = typeof legacyThemeKey === "string" ? legacyThemeKey : persistedConfig?.theme;
  const legacySwatch =
    typeof rawKey === "string" && rawKey in CLASSIC_ACCENT_SWATCHES
      ? CLASSIC_ACCENT_SWATCHES[rawKey as ClassicAccentKey]
      : undefined;
  const legacyAccent = legacySwatch?.accent;

  return {
    lightTheme: normalizeThemeVariantConfig("light", persistedConfig?.lightTheme, legacyAccent),
    darkTheme: normalizeThemeVariantConfig("dark", persistedConfig?.darkTheme, legacyAccent),
    blackTheme: normalizeBlackThemeConfig(persistedConfig?.blackTheme, legacyAccent),
  };
}

export function deriveAccentTokens(accentHex: string): ThemeAccentTokens {
  const normalized = normalizeHexColor(accentHex, "#9333EA");
  const classicKey = findMatchingClassicAccentKey(normalized);
  if (classicKey) {
    const swatch = CLASSIC_ACCENT_SWATCHES[classicKey];
    return {
      accent: swatch.accent,
      hover: swatch.hover,
      light: swatch.light,
      subtle: swatch.subtle,
      subtleBorder: swatch.subtleBorder,
      contrast: swatch.contrast,
      name: swatch.name,
    };
  }
  const luminance = getRelativeLuminance(normalized);
  return {
    accent: normalized,
    hover: mixHex(normalized, "#000000", 0.16),
    light: mixHex(normalized, "#FFFFFF", 0.22),
    subtle: hexToRgba(normalized, 0.15),
    subtleBorder: hexToRgba(normalized, 0.32),
    contrast: luminance > 0.4 ? "#111827" : "#ffffff",
    name: normalized,
  };
}

function deriveSurfaceScale(
  effectiveMode: ResolvedThemeMode,
  background: string,
  foreground: string,
): ThemeSurfaceScale {
  if (effectiveMode === "black") {
    return {
      surface0: "#000000",
      surface1: "#030304",
      surface2: "#070708",
      surface3: "#0b0b0d",
      surface4: "#101014",
      surfaceBorder: "#202026",
      surfaceBorderSoft: "#141418",
      text: "#e7e7ea",
      textStrong: "#ffffff",
      textMuted: "#a5a5ae",
      textSubtle: "#74747e",
      scrollbar: "#2f2f36",
      scrollbarHover: "#464650",
    };
  }

  if (effectiveMode === "light") {
    if (background === "#F4F4F5" && foreground === "#18181B") {
      return {
        surface0: "#f4f4f5",
        surface1: "#fafafa",
        surface2: "#ffffff",
        surface3: "#e4e4e7",
        surface4: "#d4d4d8",
        surfaceBorder: "#d4d4d8",
        surfaceBorderSoft: "#e4e4e7",
        text: "#18181b",
        textStrong: "#09090b",
        textMuted: "#52525b",
        textSubtle: "#71717a",
        scrollbar: "#a1a1aa",
        scrollbarHover: "#71717a",
      };
    }

    return {
      surface0: background,
      surface1: mixHex(background, "#FFFFFF", 0.48),
      surface2: mixHex(background, "#FFFFFF", 0.78),
      surface3: mixHex(background, foreground, 0.075),
      surface4: mixHex(background, foreground, 0.135),
      surfaceBorder: mixHex(background, foreground, 0.18),
      surfaceBorderSoft: mixHex(background, foreground, 0.11),
      text: foreground,
      textStrong: mixHex(foreground, "#000000", 0.25),
      textMuted: mixHex(foreground, background, 0.28),
      textSubtle: mixHex(foreground, background, 0.46),
      scrollbar: mixHex(background, foreground, 0.32),
      scrollbarHover: mixHex(background, foreground, 0.48),
    };
  }

  // Dark mode
  if (background === "#111112" && foreground === "#E4E4E7") {
    return {
      surface0: "#111112",
      surface1: "#151518",
      surface2: "#19191d",
      surface3: "#202025",
      surface4: "#26262c",
      surfaceBorder: "#2b2b32",
      surfaceBorderSoft: "#232329",
      text: "#e4e4e7",
      textStrong: "#f5f5f5",
      textMuted: "#b0b0ba",
      textSubtle: "#8c8c97",
      scrollbar: "#4b4b55",
      scrollbarHover: "#666670",
    };
  }

  return {
    surface0: background,
    surface1: mixHex(background, foreground, 0.035),
    surface2: mixHex(background, foreground, 0.065),
    surface3: mixHex(background, foreground, 0.105),
    surface4: mixHex(background, foreground, 0.15),
    surfaceBorder: mixHex(background, foreground, 0.165),
    surfaceBorderSoft: mixHex(background, foreground, 0.11),
    text: foreground,
    textStrong: mixHex(foreground, "#FFFFFF", 0.35),
    textMuted: mixHex(foreground, background, 0.26),
    textSubtle: mixHex(foreground, background, 0.44),
    scrollbar: mixHex(background, foreground, 0.28),
    scrollbarHover: mixHex(background, foreground, 0.4),
  };
}

export function deriveThemePalette(params: {
  effectiveMode: ResolvedThemeMode;
  lightTheme?: Partial<ThemeVariantConfig> | null;
  darkTheme?: Partial<ThemeVariantConfig> | null;
  blackTheme?: Partial<BlackThemeConfig> | null;
  legacyThemeKey?: unknown;
}): DerivedThemePalette {
  const normalized = normalizeThemeConfigFields(
    {
      lightTheme: params.lightTheme,
      darkTheme: params.darkTheme,
      blackTheme: params.blackTheme,
    },
    params.legacyThemeKey,
  );

  let preset = "default";
  let background = "#111112";
  let foreground = "#E4E4E7";
  let accentHex = normalized.darkTheme.accent;

  if (params.effectiveMode === "black") {
    preset = "black";
    background = "#000000";
    foreground = "#E7E7EA";
    accentHex = normalized.blackTheme.accent;
  } else if (params.effectiveMode === "light") {
    preset = normalized.lightTheme.preset;
    background = normalized.lightTheme.background;
    foreground = normalized.lightTheme.foreground;
    accentHex = normalized.lightTheme.accent;
  } else {
    preset = normalized.darkTheme.preset;
    background = normalized.darkTheme.background;
    foreground = normalized.darkTheme.foreground;
    accentHex = normalized.darkTheme.accent;
  }

  const surfaces = deriveSurfaceScale(params.effectiveMode, background, foreground);
  const accentTokens = deriveAccentTokens(accentHex);

  const codeSurface: DerivedCodeSurfaceTone =
    params.effectiveMode === "light"
      ? {
          border: surfaces.surfaceBorder,
          background: surfaces.surface1,
          headerBackground: surfaces.surface2,
          text: surfaces.text,
        }
      : params.effectiveMode === "black"
      ? {
          border: "#202026",
          background: "#000000",
          headerBackground: "#070708",
          text: "#dedee3",
        }
      : {
          border: surfaces.surfaceBorderSoft,
          background: mixHex(surfaces.surface0, "#000000", 0.22),
          headerBackground: surfaces.surface1,
          text: surfaces.text,
        };

  const expandedModalTone: DerivedExpandedModalTone =
    params.effectiveMode === "light"
      ? {
          overlay: "rgba(15,23,42,0.24)",
          modalBorder: surfaces.surfaceBorder,
          modalBackground: surfaces.surface2,
          modalShadow: "0 28px 80px rgba(15,23,42,0.18)",
          headerBorder: surfaces.surfaceBorderSoft,
          titleText: surfaces.textStrong,
          buttonBorder: surfaces.surfaceBorder,
          buttonBackground: surfaces.surface1,
          buttonText: surfaces.textMuted,
          bodyBackground: surfaces.surface1,
        }
      : {
          overlay: "rgba(0,0,0,0.68)",
          modalBorder: surfaces.surfaceBorder,
          modalBackground: surfaces.surface2,
          modalShadow: "0 28px 80px rgba(0,0,0,0.45)",
          headerBorder: surfaces.surfaceBorderSoft,
          titleText: surfaces.textStrong,
          buttonBorder: surfaces.surfaceBorder,
          buttonBackground: surfaces.surface1,
          buttonText: surfaces.textMuted,
          bodyBackground: surfaces.surface0,
        };

  const mermaidThemeVariables =
    params.effectiveMode === "light"
      ? {
          darkMode: false,
          background: surfaces.surface2,
          primaryColor: surfaces.surface1,
          primaryBorderColor: surfaces.surfaceBorder,
          primaryTextColor: surfaces.textStrong,
          secondaryColor: mixHex(surfaces.surface2, accentTokens.accent, 0.1),
          secondaryBorderColor: accentTokens.accent,
          secondaryTextColor: surfaces.textStrong,
          tertiaryColor: mixHex(surfaces.surface1, accentTokens.light, 0.12),
          tertiaryBorderColor: accentTokens.hover,
          tertiaryTextColor: surfaces.textStrong,
          clusterBkg: surfaces.surface1,
          clusterBorder: surfaces.surfaceBorder,
          lineColor: surfaces.textMuted,
          edgeLabelBackground: surfaces.surface2,
          mainBkg: surfaces.surface2,
          nodeBorder: surfaces.surfaceBorder,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }
      : {
          darkMode: true,
          background: surfaces.surface2,
          primaryColor: surfaces.surface3,
          primaryBorderColor: surfaces.surfaceBorder,
          primaryTextColor: surfaces.textStrong,
          secondaryColor: mixHex(surfaces.surface2, accentTokens.accent, 0.16),
          secondaryBorderColor: accentTokens.light,
          secondaryTextColor: surfaces.textStrong,
          tertiaryColor: mixHex(surfaces.surface1, accentTokens.accent, 0.2),
          tertiaryBorderColor: accentTokens.accent,
          tertiaryTextColor: surfaces.textStrong,
          clusterBkg: surfaces.surface1,
          clusterBorder: surfaces.surfaceBorder,
          lineColor: surfaces.textMuted,
          edgeLabelBackground: surfaces.surface1,
          mainBkg: surfaces.surface2,
          nodeBorder: surfaces.surfaceBorder,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        };

  const terminalTheme: DerivedTerminalTheme =
    params.effectiveMode === "light"
      ? {
          background: surfaces.surface2,
          foreground: surfaces.text,
          cursor: accentTokens.accent,
          cursorAccent: surfaces.surface2,
          selectionBackground: surfaces.surface3,
          black: surfaces.text,
          red: "#dc2626",
          green: "#059669",
          yellow: "#ca8a04",
          blue: "#2563eb",
          magenta: accentTokens.accent,
          cyan: "#0891b2",
          white: surfaces.textMuted,
          brightBlack: surfaces.textSubtle,
          brightRed: "#ef4444",
          brightGreen: "#10b981",
          brightYellow: "#eab308",
          brightBlue: "#3b82f6",
          brightMagenta: accentTokens.light,
          brightCyan: "#06b6d4",
          brightWhite: surfaces.textStrong,
        }
      : params.effectiveMode === "black"
      ? {
          background: "#000000",
          foreground: "#dedee3",
          cursor: accentTokens.light,
          cursorAccent: "#000000",
          selectionBackground: "#202026",
          black: "#050506",
          red: "#f48771",
          green: "#86d9a3",
          yellow: "#fbbf24",
          blue: "#6cb6ff",
          magenta: accentTokens.light,
          cyan: "#56d4dd",
          white: "#dedee3",
          brightBlack: "#74747e",
          brightRed: "#f48771",
          brightGreen: "#86d9a3",
          brightYellow: "#fbbf24",
          brightBlue: "#6cb6ff",
          brightMagenta: accentTokens.light,
          brightCyan: "#56d4dd",
          brightWhite: "#ffffff",
        }
      : {
          background: surfaces.surface0,
          foreground: surfaces.text,
          cursor: accentTokens.light,
          cursorAccent: surfaces.surface0,
          selectionBackground: surfaces.surface4,
          black: surfaces.surface1,
          red: "#f48771",
          green: "#86d9a3",
          yellow: "#fbbf24",
          blue: "#6cb6ff",
          magenta: accentTokens.light,
          cyan: "#56d4dd",
          white: surfaces.text,
          brightBlack: surfaces.textSubtle,
          brightRed: "#f48771",
          brightGreen: "#86d9a3",
          brightYellow: "#fbbf24",
          brightBlue: "#6cb6ff",
          brightMagenta: accentTokens.light,
          brightCyan: "#56d4dd",
          brightWhite: surfaces.textStrong,
        };

  const signature = `${params.effectiveMode}:${preset}:${background}:${foreground}:${accentTokens.accent}`;

  return {
    effectiveMode: params.effectiveMode,
    preset,
    background,
    foreground,
    surfaces,
    accentTokens,
    codeSurface,
    expandedModalTone,
    mermaidThemeVariables,
    terminalTheme,
    signature,
  };
}
