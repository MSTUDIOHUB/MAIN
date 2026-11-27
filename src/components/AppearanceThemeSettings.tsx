import React, { useEffect, useMemo, useState } from "react";
import { IconChevronDown, IconChevronRight } from "./Icons";
import {
  CLASSIC_ACCENT_KEYS,
  CLASSIC_ACCENT_SWATCHES,
  deriveThemePalette,
  findMatchingClassicAccentKey,
  findThemePreset,
  getDefaultBlackThemeConfig,
  getThemePresetsForVariant,
  isValidHexColor,
  normalizeBlackThemeConfig,
  normalizeHexColor,
  normalizeThemeVariantConfig,
  resolveMatchingPresetId,
  type BlackThemeConfig,
  type ThemeVariantConfig,
  type ThemeVariantKind,
} from "../lib/themePresets";
import { useEffectiveThemeMode } from "./useThemePalette";

interface AppearanceThemeSettingsProps {
  config: any;
  setConfig: (patch: any) => void;
  language: "zh" | "en";
  t: any;
}

function ColorHexPill({
  value,
  label,
  testId,
  onChangeHex,
}: {
  value: string;
  label: string;
  testId: string;
  onChangeHex: (nextHex: string) => void;
}) {
  const normalizedValue = normalizeHexColor(value, "#9333EA");
  const [draft, setDraft] = useState(normalizedValue);

  useEffect(() => {
    setDraft(normalizedValue);
  }, [normalizedValue]);

  const commitDraft = (raw: string) => {
    const candidate = raw.trim().startsWith("#") ? raw.trim() : `#${raw.trim()}`;
    if (isValidHexColor(candidate)) {
      const normalized = normalizeHexColor(candidate, normalizedValue);
      setDraft(normalized);
      onChangeHex(normalized);
    } else {
      setDraft(normalizedValue);
    }
  };

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[var(--surface-border)] bg-[var(--surface-3)] py-1 pl-1.5 pr-3 transition-colors focus-within:border-[var(--accent)]">
      <label
        className="relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-black/15 shadow-inner"
        style={{ backgroundColor: normalizedValue }}
        title={label}
      >
        <input
          type="color"
          aria-label={`${label} picker`}
          value={normalizedValue}
          onChange={(e) => {
            const next = normalizeHexColor(e.target.value, normalizedValue);
            setDraft(next);
            onChangeHex(next);
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <input
        type="text"
        data-testid={testId}
        aria-label={label}
        value={draft}
        maxLength={7}
        spellCheck={false}
        onChange={(e) => {
          const nextRaw = e.target.value;
          setDraft(nextRaw);
          const trimmed = nextRaw.trim();
          const candidate = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
          if (/^#[0-9a-fA-F]{6}$/.test(candidate)) {
            onChangeHex(candidate.toUpperCase());
          }
        }}
        onBlur={() => commitDraft(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitDraft(draft);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(normalizedValue);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-[74px] bg-transparent font-mono text-[12px] font-medium uppercase tracking-wide text-[var(--surface-text-strong)] outline-none"
      />
    </div>
  );
}

function ThemeCardCodePreview({
  variant,
  lightTheme,
  darkTheme,
  blackTheme,
  legacyThemeKey,
  language,
  label,
}: {
  variant: "light" | "dark" | "black";
  lightTheme: ThemeVariantConfig;
  darkTheme: ThemeVariantConfig;
  blackTheme: BlackThemeConfig;
  legacyThemeKey?: string;
  language: "zh" | "en";
  label: string;
}) {
  const [open, setOpen] = useState(false);

  const previewPalette = useMemo(
    () =>
      deriveThemePalette({
        effectiveMode: variant,
        lightTheme,
        darkTheme,
        blackTheme,
        legacyThemeKey,
      }),
    [variant, lightTheme, darkTheme, blackTheme, legacyThemeKey],
  );

  const isLight = variant === "light";
  const keywordColor = isLight ? "#7C3AED" : "#C084FC";
  const stringColor = isLight ? "#059669" : "#6EE7B7";
  const fnColor = isLight ? "#2563EB" : "#60A5FA";

  return (
    <div className="border-t border-[var(--surface-border-soft)]">
      <button
        type="button"
        data-testid={`theme-code-preview-toggle-${variant}`}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-[12px] font-medium text-[var(--surface-text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--surface-text-strong)]"
      >
        <span>{label}</span>
        {open ? (
          <IconChevronDown className="h-3.5 w-3.5 opacity-75" />
        ) : (
          <IconChevronRight className="h-3.5 w-3.5 opacity-75" />
        )}
      </button>

      {open && (
        <div
          data-testid={`theme-code-preview-panel-${variant}`}
          className="border-t border-[var(--surface-border-soft)] px-4 py-3"
          style={{
            backgroundColor: previewPalette.surfaces.surface0,
            color: previewPalette.surfaces.text,
          }}
        >
          <div
            className="overflow-hidden rounded-lg border font-mono text-[11.5px] leading-relaxed"
            style={{
              borderColor: previewPalette.codeSurface.border,
              backgroundColor: previewPalette.codeSurface.background,
              color: previewPalette.codeSurface.text,
            }}
          >
            <div
              className="flex items-center justify-between border-b px-3 py-1.5 text-[10.5px]"
              style={{
                borderColor: previewPalette.codeSurface.border,
                backgroundColor: previewPalette.codeSurface.headerBackground,
                color: previewPalette.surfaces.textSubtle,
              }}
            >
              <span>theme-preview.ts</span>
              <span
                className="rounded-full px-2 py-0.5 font-sans text-[10px] font-semibold"
                style={{
                  backgroundColor: previewPalette.accentTokens.accent,
                  color: previewPalette.accentTokens.contrast,
                }}
              >
                {language === "en" ? "Accent" : "强调色"}
              </span>
            </div>
            <pre className="m-0 overflow-x-auto px-3 py-2.5">
              <code>
                <span style={{ color: previewPalette.surfaces.textSubtle }}>
                  {"// "}
                  {language === "en" ? "Live surface & accent tokens" : "当前配色与强调色效果"}
                  {"\n"}
                </span>
                <span style={{ color: keywordColor }}>export function </span>
                <span style={{ color: fnColor }}>applyTheme</span>
                <span>(mode: </span>
                <span style={{ color: stringColor }}>{`"${variant}"`}</span>
                <span>) {"{\n"}</span>
                <span>{"  return { bg: "}</span>
                <span style={{ color: stringColor }}>{`"${previewPalette.background}"`}</span>
                <span>{", accent: "}</span>
                <span style={{ color: previewPalette.accentTokens.light }}>{`"${previewPalette.accentTokens.accent}"`}</span>
                <span>{" };\n}"}</span>
              </code>
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function VariantThemeCard({
  variant,
  title,
  isActiveBadge,
  variantConfig,
  lightTheme,
  darkTheme,
  blackTheme,
  legacyThemeKey,
  language,
  t,
  onUpdateVariant,
  onSyncLegacyThemeKey,
}: {
  variant: ThemeVariantKind;
  title: string;
  isActiveBadge: boolean;
  variantConfig: ThemeVariantConfig;
  lightTheme: ThemeVariantConfig;
  darkTheme: ThemeVariantConfig;
  blackTheme: BlackThemeConfig;
  legacyThemeKey?: string;
  language: "zh" | "en";
  t: any;
  onUpdateVariant: (next: ThemeVariantConfig) => void;
  onSyncLegacyThemeKey: (accentHex: string) => void;
}) {
  const presets = getThemePresetsForVariant(variant);
  const currentPresetValue = resolveMatchingPresetId(variant, variantConfig);

  const handlePresetChange = (nextPresetId: string) => {
    const preset = findThemePreset(variant, nextPresetId);
    if (!preset) return;
    onUpdateVariant({
      preset: preset.id,
      background: preset.background,
      foreground: preset.foreground,
      accent: preset.accent,
    });
    onSyncLegacyThemeKey(preset.accent);
  };

  const handleFieldChange = (field: "background" | "foreground" | "accent", nextHex: string) => {
    const updated = {
      ...variantConfig,
      [field]: nextHex,
    };
    const matchedPreset = resolveMatchingPresetId(variant, updated);
    onUpdateVariant({
      ...updated,
      preset: matchedPreset,
    });
    if (field === "accent") {
      onSyncLegacyThemeKey(nextHex);
    }
  };

  return (
    <div className="space-y-2" data-testid={`theme-card-${variant}`}>
      <div className="flex items-center gap-2 px-1">
        <span className="text-[13px] font-bold text-[var(--surface-text-strong)]">{title}</span>
        {isActiveBadge && (
          <span className="rounded-full border theme-subtle-border theme-subtle-bg px-2 py-0.5 text-[10px] font-semibold">
            {t.themeActiveBadge}
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--surface-border)] bg-[var(--surface-1)]">
        {/* Preset */}
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <label
            htmlFor={`theme-preset-${variant}`}
            className="text-[13px] font-medium text-[var(--surface-text)]"
          >
            {t.themePreset}
          </label>
          <div className="flex items-center gap-2">
            {currentPresetValue === "custom" && (
              <button
                type="button"
                onClick={() => handlePresetChange("default")}
                className="rounded-full border border-[var(--surface-border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-medium text-[var(--surface-text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--surface-text-strong)]"
              >
                {t.themeResetPreset}
              </button>
            )}
            <select
              id={`theme-preset-${variant}`}
              data-testid={`theme-preset-select-${variant}`}
              value={currentPresetValue}
              onChange={(e) => handlePresetChange(e.target.value)}
              className="min-w-[164px] cursor-pointer rounded-full border border-[var(--surface-border)] bg-[var(--surface-3)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--surface-text-strong)] outline-none transition-colors focus:border-[var(--accent)]"
            >
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {language === "en" ? preset.nameEn : preset.nameZh}
                </option>
              ))}
              {currentPresetValue === "custom" && (
                <option value="custom">{t.themeCustomPreset}</option>
              )}
            </select>
          </div>
        </div>

        {/* Background */}
        <div className="flex items-center justify-between gap-4 border-t border-[var(--surface-border-soft)] px-4 py-3">
          <span className="text-[13px] font-medium text-[var(--surface-text)]">
            {t.themeBackground}
          </span>
          <ColorHexPill
            value={variantConfig.background}
            label={`${title} ${t.themeBackground}`}
            testId={`theme-color-${variant}-background`}
            onChangeHex={(hex) => handleFieldChange("background", hex)}
          />
        </div>

        {/* Foreground */}
        <div className="flex items-center justify-between gap-4 border-t border-[var(--surface-border-soft)] px-4 py-3">
          <span className="text-[13px] font-medium text-[var(--surface-text)]">
            {t.themeForeground}
          </span>
          <ColorHexPill
            value={variantConfig.foreground}
            label={`${title} ${t.themeForeground}`}
            testId={`theme-color-${variant}-foreground`}
            onChangeHex={(hex) => handleFieldChange("foreground", hex)}
          />
        </div>

        {/* Accent */}
        <div className="border-t border-[var(--surface-border-soft)] px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13px] font-medium text-[var(--surface-text)]">
              {t.themeAccent}
            </span>
            <ColorHexPill
              value={variantConfig.accent}
              label={`${title} ${t.themeAccent}`}
              testId={`theme-color-${variant}-accent`}
              onChangeHex={(hex) => handleFieldChange("accent", hex)}
            />
          </div>
          <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
            {CLASSIC_ACCENT_KEYS.map((key) => {
              const swatch = CLASSIC_ACCENT_SWATCHES[key];
              const isSelected =
                normalizeHexColor(variantConfig.accent, "") === swatch.accent.toUpperCase();
              return (
                <button
                  key={key}
                  type="button"
                  title={swatch.name}
                  aria-label={`${swatch.name}`}
                  onClick={() => handleFieldChange("accent", swatch.accent)}
                  className={`h-4 w-4 cursor-pointer rounded-full transition-transform ${
                    isSelected
                      ? "scale-110 ring-2 ring-[var(--surface-text-strong)] ring-offset-2 ring-offset-[var(--surface-1)]"
                      : "opacity-80 hover:scale-105 hover:opacity-100"
                  }`}
                  style={{ backgroundColor: swatch.accent }}
                />
              );
            })}
          </div>
        </div>

        <ThemeCardCodePreview
          variant={variant}
          lightTheme={lightTheme}
          darkTheme={darkTheme}
          blackTheme={blackTheme}
          legacyThemeKey={legacyThemeKey}
          language={language}
          label={t.themeCodePreview}
        />
      </div>
    </div>
  );
}

export default function AppearanceThemeSettings({
  config,
  setConfig,
  language,
  t,
}: AppearanceThemeSettingsProps) {
  const effectiveThemeMode = useEffectiveThemeMode();
  const currentMode = (config.themeMode || "dark") as "system" | "light" | "dark" | "black";

  const lightTheme = useMemo(
    () =>
      normalizeThemeVariantConfig(
        "light",
        config.lightTheme,
        config.theme && config.theme in CLASSIC_ACCENT_SWATCHES
          ? CLASSIC_ACCENT_SWATCHES[config.theme as keyof typeof CLASSIC_ACCENT_SWATCHES].accent
          : undefined,
      ),
    [config.lightTheme, config.theme],
  );

  const darkTheme = useMemo(
    () =>
      normalizeThemeVariantConfig(
        "dark",
        config.darkTheme,
        config.theme && config.theme in CLASSIC_ACCENT_SWATCHES
          ? CLASSIC_ACCENT_SWATCHES[config.theme as keyof typeof CLASSIC_ACCENT_SWATCHES].accent
          : undefined,
      ),
    [config.darkTheme, config.theme],
  );

  const blackTheme = useMemo(
    () =>
      normalizeBlackThemeConfig(
        config.blackTheme,
        config.theme && config.theme in CLASSIC_ACCENT_SWATCHES
          ? CLASSIC_ACCENT_SWATCHES[config.theme as keyof typeof CLASSIC_ACCENT_SWATCHES].accent
          : getDefaultBlackThemeConfig().accent,
      ),
    [config.blackTheme, config.theme],
  );

  const resolveNextLegacyThemeKey = (accentHex: string) => {
    const matched = findMatchingClassicAccentKey(accentHex);
    return matched ?? config.theme ?? "purple";
  };

  const modeOptions: Array<{
    id: "system" | "light" | "dark" | "black";
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      id: "system",
      label: t.themeModeSystem,
      icon: (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      ),
    },
    {
      id: "light",
      label: t.themeModeLight,
      icon: (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ),
    },
    {
      id: "dark",
      label: t.themeModeDark,
      icon: (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ),
    },
    {
      id: "black",
      label: t.themeModeBlack,
      icon: (
        <span className="h-3.5 w-3.5 rounded-full border border-current bg-black shadow-[inset_0_0_0_2px_rgba(255,255,255,0.12)]" />
      ),
    },
  ];

  const showLightCard = currentMode === "light" || currentMode === "system";
  const showDarkCard = currentMode === "dark" || currentMode === "system";
  const showBlackCard = currentMode === "black";

  return (
    <div className="space-y-5 border-t border-[var(--surface-border)] pt-5">
      {/* Appearance Card */}
      <div className="space-y-2">
        <div className="px-1">
          <span className="text-[13px] font-bold text-[var(--surface-text-strong)]">
            {t.themeMode}
          </span>
        </div>

        <div className="overflow-hidden rounded-xl border border-[var(--surface-border)] bg-[var(--surface-1)]">
          {/* Theme mode segmented switcher */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="text-[13px] font-medium text-[var(--surface-text)]">
              {language === "en" ? "Theme" : "主题模式"}
            </span>
            <div className="inline-flex flex-wrap items-center gap-1 rounded-full border border-[var(--surface-border)] bg-[var(--surface-3)] p-1">
              {modeOptions.map((option) => {
                const isSelected = currentMode === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    data-testid={`theme-mode-${option.id}`}
                    aria-pressed={isSelected}
                    onClick={() => setConfig({ ...config, themeMode: option.id })}
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold transition-all ${
                      isSelected
                        ? "bg-[var(--surface-2)] text-[var(--surface-text-strong)] shadow-sm ring-1 ring-[var(--surface-border)]"
                        : "text-[var(--surface-text-muted)] hover:text-[var(--surface-text-strong)]"
                    }`}
                  >
                    {option.icon}
                    <span>{option.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Chat Font Size */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--surface-border-soft)] px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[var(--surface-text)]">
                {t.chatFontSize}
              </div>
              <p className="mt-0.5 text-[11.5px] text-[var(--surface-text-subtle)]">
                {t.chatFontSizeDesc}
              </p>
            </div>
            {(() => {
              const fontSize = Math.min(20, Math.max(10, Number(config.chatFontSize ?? 13) || 13));
              const sliderProgress = `${((fontSize - 10) / 10) * 100}%`;
              return (
                <div className="flex w-full max-w-[260px] items-center gap-3">
                  <input
                    data-testid="chat-font-size-slider"
                    type="range"
                    min={10}
                    max={20}
                    step={1}
                    value={fontSize}
                    style={{ "--slider-progress": sliderProgress } as React.CSSProperties}
                    onChange={(e) =>
                      setConfig({ ...config, chatFontSize: parseInt(e.target.value, 10) })
                    }
                    className="theme-slider w-full cursor-pointer"
                  />
                  <span
                    data-testid="chat-font-size-badge"
                    className="shrink-0 rounded-full border border-[var(--surface-border)] bg-[var(--surface-3)] px-3 py-1 font-mono text-[12px] font-semibold text-[var(--surface-text-strong)]"
                  >
                    {fontSize} px
                  </span>
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      {/* Light Theme Card */}
      {showLightCard && (
        <VariantThemeCard
          variant="light"
          title={t.lightThemeCard}
          isActiveBadge={currentMode === "system" && effectiveThemeMode === "light"}
          variantConfig={lightTheme}
          lightTheme={lightTheme}
          darkTheme={darkTheme}
          blackTheme={blackTheme}
          legacyThemeKey={config.theme}
          language={language}
          t={t}
          onUpdateVariant={(nextLight) =>
            setConfig({
              ...config,
              lightTheme: nextLight,
              theme: resolveNextLegacyThemeKey(nextLight.accent),
            })
          }
          onSyncLegacyThemeKey={() => {}}
        />
      )}

      {/* Dark Theme Card */}
      {showDarkCard && (
        <VariantThemeCard
          variant="dark"
          title={t.darkThemeCard}
          isActiveBadge={currentMode === "system" && effectiveThemeMode === "dark"}
          variantConfig={darkTheme}
          lightTheme={lightTheme}
          darkTheme={darkTheme}
          blackTheme={blackTheme}
          legacyThemeKey={config.theme}
          language={language}
          t={t}
          onUpdateVariant={(nextDark) =>
            setConfig({
              ...config,
              darkTheme: nextDark,
              theme: resolveNextLegacyThemeKey(nextDark.accent),
            })
          }
          onSyncLegacyThemeKey={() => {}}
        />
      )}

      {/* Black Theme Card (Pure Black locked surface, customizable Accent) */}
      {showBlackCard && (
        <div className="space-y-2" data-testid="theme-card-black">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-[13px] font-bold text-[var(--surface-text-strong)]">
              {t.blackThemeCard}
            </span>
            <span className="rounded-full border border-[var(--surface-border)] bg-[var(--surface-2)] px-2.5 py-0.5 font-mono text-[10.5px] text-[var(--surface-text-muted)]">
              {language === "en" ? "Pure Black #000000" : "纯黑底色 #000000"}
            </span>
          </div>

          <div className="overflow-hidden rounded-xl border border-[var(--surface-border)] bg-[var(--surface-1)]">
            <div className="px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-[13px] font-medium text-[var(--surface-text)]">
                    {t.themeAccent}
                  </span>
                  <p className="mt-0.5 text-[11.5px] text-[var(--surface-text-subtle)]">
                    {language === "en"
                      ? "Pure black keeps OLED #000000 background and lets you customize the highlight color."
                      : "黑色主题保留纯黑背景与高对比文字，仅自定义主题高亮色。"}
                  </p>
                </div>
                <ColorHexPill
                  value={blackTheme.accent}
                  label={`${t.blackThemeCard} ${t.themeAccent}`}
                  testId="theme-color-black-accent"
                  onChangeHex={(hex) =>
                    setConfig({
                      ...config,
                      blackTheme: { accent: hex },
                      theme: resolveNextLegacyThemeKey(hex),
                    })
                  }
                />
              </div>

              <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
                {CLASSIC_ACCENT_KEYS.map((key) => {
                  const swatch = CLASSIC_ACCENT_SWATCHES[key];
                  const isSelected =
                    normalizeHexColor(blackTheme.accent, "") === swatch.accent.toUpperCase();
                  return (
                    <button
                      key={key}
                      type="button"
                      title={swatch.name}
                      aria-label={swatch.name}
                      onClick={() =>
                        setConfig({
                          ...config,
                          blackTheme: { accent: swatch.accent },
                          theme: key,
                        })
                      }
                      className={`h-4 w-4 cursor-pointer rounded-full transition-transform ${
                        isSelected
                          ? "scale-110 ring-2 ring-[var(--surface-text-strong)] ring-offset-2 ring-offset-[var(--surface-1)]"
                          : "opacity-80 hover:scale-105 hover:opacity-100"
                      }`}
                      style={{ backgroundColor: swatch.accent }}
                    />
                  );
                })}
              </div>
            </div>

            <ThemeCardCodePreview
              variant="black"
              lightTheme={lightTheme}
              darkTheme={darkTheme}
              blackTheme={blackTheme}
              legacyThemeKey={config.theme}
              language={language}
              label={t.themeCodePreview}
            />
          </div>
        </div>
      )}
    </div>
  );
}
