import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  const localRequire = createRequire(normalizedPath);
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  return module.exports;
}

const {
  LIGHT_THEME_PRESETS,
  DARK_THEME_PRESETS,
  CLASSIC_ACCENT_SWATCHES,
  isValidHexColor,
  normalizeHexColor,
  resolveEffectiveThemeMode,
  resolveMatchingPresetId,
  normalizeThemeConfigFields,
  deriveAccentTokens,
  deriveThemePalette,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/themePresets.ts"));

test("resolveEffectiveThemeMode maps system mode to light/dark and preserves explicit modes", () => {
  assert.equal(resolveEffectiveThemeMode("system", true), "light");
  assert.equal(resolveEffectiveThemeMode("system", false), "dark");
  assert.equal(resolveEffectiveThemeMode("light", false), "light");
  assert.equal(resolveEffectiveThemeMode("dark", true), "dark");
  assert.equal(resolveEffectiveThemeMode("black", true), "black");
  assert.equal(resolveEffectiveThemeMode("unknown", true), "dark");
});

test("normalizeHexColor expands 3-digit hex and falls back on invalid inputs", () => {
  assert.equal(isValidHexColor("#abc"), true);
  assert.equal(isValidHexColor("#eaecf0"), true);
  assert.equal(isValidHexColor("not-a-color"), false);
  assert.equal(normalizeHexColor("#abc", "#000000"), "#AABBCC");
  assert.equal(normalizeHexColor(" #8839ef ", "#000000"), "#8839EF");
  assert.equal(normalizeHexColor("invalid", "#111112"), "#111112");
});

test("resolveMatchingPresetId detects built-in presets vs custom edits", () => {
  const catppuccinLight = LIGHT_THEME_PRESETS.find((p) => p.id === "catppuccin");
  assert.ok(catppuccinLight);
  assert.equal(
    resolveMatchingPresetId("light", {
      background: catppuccinLight.background.toLowerCase(),
      foreground: catppuccinLight.foreground,
      accent: catppuccinLight.accent,
    }),
    "catppuccin",
  );
  assert.equal(
    resolveMatchingPresetId("light", {
      background: "#FFFFFF",
      foreground: catppuccinLight.foreground,
      accent: catppuccinLight.accent,
    }),
    "custom",
  );

  const warmCharcoal = DARK_THEME_PRESETS.find((p) => p.id === "warm-charcoal");
  assert.ok(warmCharcoal);
  assert.equal(
    resolveMatchingPresetId("dark", {
      background: warmCharcoal.background,
      foreground: warmCharcoal.foreground,
      accent: warmCharcoal.accent,
    }),
    "warm-charcoal",
  );
});

test("normalizeThemeConfigFields migrates legacy theme key into light/dark/black accent", () => {
  const migrated = normalizeThemeConfigFields({}, "hermesOrange");
  assert.equal(migrated.lightTheme.accent, CLASSIC_ACCENT_SWATCHES.hermesOrange.accent);
  assert.equal(migrated.darkTheme.accent, CLASSIC_ACCENT_SWATCHES.hermesOrange.accent);
  assert.equal(migrated.blackTheme.accent, CLASSIC_ACCENT_SWATCHES.hermesOrange.accent);
  assert.equal(migrated.lightTheme.preset, "custom");
  assert.equal(migrated.darkTheme.preset, "custom");
});

test("deriveAccentTokens preserves classic swatches and computes accessible contrast for custom colors", () => {
  const classic = deriveAccentTokens("#81d8d0");
  assert.equal(classic.name, "Tiffany Blue");
  assert.equal(classic.contrast, "#063433");

  const lightAccent = deriveAccentTokens("#CBA6F7");
  assert.equal(lightAccent.contrast, "#111827");

  const darkAccent = deriveAccentTokens("#8839EF");
  assert.equal(darkAccent.contrast, "#ffffff");
});

test("deriveThemePalette preserves exact default surfaces and derives Catppuccin/Black palettes", () => {
  const defaultDark = deriveThemePalette({ effectiveMode: "dark" });
  assert.equal(defaultDark.surfaces.surface0, "#111112");
  assert.equal(defaultDark.surfaces.surface2, "#19191d");
  assert.equal(defaultDark.surfaces.text, "#e4e4e7");

  const defaultLight = deriveThemePalette({ effectiveMode: "light" });
  assert.equal(defaultLight.surfaces.surface0, "#f4f4f5");
  assert.equal(defaultLight.surfaces.surface2, "#ffffff");

  const black = deriveThemePalette({
    effectiveMode: "black",
    blackTheme: { accent: "#007ACC" },
  });
  assert.equal(black.surfaces.surface0, "#000000");
  assert.equal(black.surfaces.textStrong, "#ffffff");
  assert.equal(black.accentTokens.accent, "#007ACC");

  const catppuccin = deriveThemePalette({
    effectiveMode: "light",
    lightTheme: {
      preset: "catppuccin",
      background: "#EAECF0",
      foreground: "#4C4F69",
      accent: "#8839EF",
    },
  });
  assert.equal(catppuccin.surfaces.surface0, "#EAECF0");
  assert.equal(catppuccin.surfaces.text, "#4C4F69");
  assert.equal(catppuccin.accentTokens.accent, "#8839EF");
  assert.equal(catppuccin.terminalTheme.background, catppuccin.surfaces.surface2);
});
