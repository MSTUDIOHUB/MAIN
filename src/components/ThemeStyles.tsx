import { useEffect } from "react";
import { useActiveThemePalette } from "./useThemePalette";

export default function ThemeStyles() {
  const palette = useActiveThemePalette();
  const { effectiveMode, surfaces, accentTokens } = palette;

  // Mount resolved data-theme attribute on <html> for CSS overrides
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", effectiveMode);
  }, [effectiveMode]);

  const surfaceVars = `
        --surface-0: ${surfaces.surface0};
        --surface-1: ${surfaces.surface1};
        --surface-2: ${surfaces.surface2};
        --surface-3: ${surfaces.surface3};
        --surface-4: ${surfaces.surface4};
        --surface-elevated: ${surfaces.surface2};
        --surface-border: ${surfaces.surfaceBorder};
        --surface-border-soft: ${surfaces.surfaceBorderSoft};
        --surface-text: ${surfaces.text};
        --surface-text-strong: ${surfaces.textStrong};
        --surface-text-muted: ${surfaces.textMuted};
        --surface-text-subtle: ${surfaces.textSubtle};
        --surface-scrollbar: ${surfaces.scrollbar};
        --surface-scrollbar-hover: ${surfaces.scrollbarHover};
  `;

  return (
    <style>{`
      :root {
        ${surfaceVars}
        --accent: ${accentTokens.accent};
        --accent-hover: ${accentTokens.hover};
        --accent-light: ${accentTokens.light};
        --accent-subtle: ${accentTokens.subtle};
        --accent-subtle-border: ${accentTokens.subtleBorder};
        --accent-contrast: ${accentTokens.contrast};
        --inline-chip-text: ${surfaces.textStrong};
      }
      html[data-theme="${effectiveMode}"],
      html[data-theme="${effectiveMode}"] body,
      html[data-theme="${effectiveMode}"] #root {
        ${surfaceVars}
        --inline-chip-text: ${surfaces.textStrong};
      }
      .theme-bg { background-color: var(--accent) !important; color: var(--accent-contrast, #ffffff) !important; }
      .theme-bg-hover:hover { background-color: var(--accent-hover) !important; color: var(--accent-contrast, #ffffff) !important; }
      html[data-theme="light"] .theme-bg, html[data-theme="light"] .theme-bg *, html[data-theme="light"] .theme-bg-hover:hover { color: var(--accent-contrast, #ffffff) !important; }
      .theme-text { color: var(--accent-light) !important; }
      .theme-border { border-color: var(--accent) !important; }
      .theme-subtle-bg { background-color: var(--accent-subtle) !important; color: var(--accent-light) !important; }
      .theme-subtle-border { border-color: var(--accent-subtle-border) !important; }
      .theme-glow { box-shadow: 0 0 8px var(--accent-subtle) !important; }
      .theme-ring:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
      .theme-plan-surface {
        border-color: color-mix(in srgb, var(--accent-light) 30%, transparent) !important;
        background: color-mix(in srgb, var(--accent) 10%, transparent) !important;
      }
      .theme-plan-pill {
        border-color: color-mix(in srgb, var(--accent-light) 34%, transparent) !important;
        background: color-mix(in srgb, var(--accent) 14%, transparent) !important;
        color: var(--accent-light) !important;
      }
      .theme-plan-text {
        color: var(--accent-light) !important;
      }
      .theme-plan-button {
        border-color: color-mix(in srgb, var(--accent-light) 34%, transparent) !important;
        background: color-mix(in srgb, var(--accent) 16%, transparent) !important;
        color: var(--accent-light) !important;
      }
      .theme-plan-button:hover {
        border-color: color-mix(in srgb, var(--accent-light) 48%, transparent) !important;
        background: color-mix(in srgb, var(--accent) 24%, transparent) !important;
      }
      .theme-plan-primary {
        background: linear-gradient(135deg, var(--accent), var(--accent-hover)) !important;
        color: var(--accent-contrast, #ffffff) !important;
      }
      .theme-plan-progress {
        background: linear-gradient(90deg, var(--accent), var(--accent-light)) !important;
      }
      .turn-process-font-scope {
        font-size: var(--turn-process-font-size, 13px);
      }
      .turn-process-font-scope :where(button, input, textarea, select, summary, label) {
        font-size: inherit;
      }
      .turn-process-font-scope .text-\\[9px\\] {
        font-size: var(--turn-process-font-9px, 9px) !important;
      }
      .turn-process-font-scope .text-\\[10px\\] {
        font-size: var(--turn-process-font-10px, 10px) !important;
      }
      .turn-process-font-scope .text-\\[10\\.5px\\] {
        font-size: var(--turn-process-font-10-5px, 10.5px) !important;
      }
      .turn-process-font-scope .text-\\[11px\\] {
        font-size: var(--turn-process-font-11px, 11px) !important;
      }
      .turn-process-font-scope .text-\\[12px\\] {
        font-size: var(--turn-process-font-12px, 12px) !important;
      }
      .turn-process-font-scope .text-\\[12\\.5px\\] {
        font-size: var(--turn-process-font-12-5px, 12.5px) !important;
      }
      .turn-process-font-scope .text-\\[13px\\] {
        font-size: var(--turn-process-font-13px, 13px) !important;
      }
      html[data-theme="light"] .theme-plan-surface {
        border-color: color-mix(in srgb, var(--accent-hover) 30%, var(--surface-2) 70%) !important;
        background: color-mix(in srgb, var(--accent) 10%, var(--surface-2) 90%) !important;
      }
      html[data-theme="light"] .theme-plan-pill,
      html[data-theme="light"] .theme-plan-text,
      html[data-theme="light"] .theme-plan-button {
        color: color-mix(in srgb, var(--accent-hover), var(--surface-text-strong) 22%) !important;
      }
      html[data-theme="black"] .theme-plan-surface {
        border-color: color-mix(in srgb, var(--accent-light) 28%, transparent) !important;
        background: color-mix(in srgb, var(--accent) 9%, #000000 91%) !important;
      }
      html[data-theme="light"] .theme-text { color: color-mix(in srgb, var(--accent-hover), var(--surface-text-strong) 28%) !important; }
      html[data-theme="light"] .theme-subtle-bg { color: color-mix(in srgb, var(--accent-hover), var(--surface-text-strong) 28%) !important; }
      .panel-tab-icon-button {
        color: #a1a1aa;
        background: transparent;
        border: 1px solid transparent;
        box-shadow: none;
      }
      .panel-tab-icon-button:hover:not(:disabled) {
        color: var(--accent-light);
        background: color-mix(in srgb, var(--accent) 16%, transparent);
        border-color: color-mix(in srgb, var(--accent-light) 30%, transparent);
      }
      .panel-tab-icon-button.is-active {
        color: var(--accent-light);
        background: transparent;
        border-color: color-mix(in srgb, var(--accent-light) 72%, transparent);
        outline: 1px solid color-mix(in srgb, var(--accent-light) 56%, transparent);
        outline-offset: -1px;
        box-shadow: none;
      }
      .panel-tab-icon-button.is-active:hover:not(:disabled) {
        color: var(--accent-light);
        background: color-mix(in srgb, var(--accent) 10%, transparent);
        border-color: color-mix(in srgb, var(--accent-light) 82%, transparent);
        outline-color: color-mix(in srgb, var(--accent-light) 70%, transparent);
      }
      .panel-tab-icon-button:disabled {
        color: #71717a;
        background: transparent;
        border-color: transparent;
        box-shadow: none;
      }
      .panel-tab-icon-button:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--accent-light) 70%, transparent);
        outline-offset: 2px;
      }
      .git-menu-theme-button {
        color: #a1a1aa;
        background: transparent;
        border: 1px solid transparent;
        box-shadow: none;
      }
      .git-menu-theme-button:hover:not(:disabled) {
        color: var(--accent-light);
        background: color-mix(in srgb, var(--accent) 16%, transparent);
        border-color: color-mix(in srgb, var(--accent-light) 30%, transparent);
      }
      .git-menu-theme-button.is-active {
        color: var(--accent-light);
        background: transparent;
        border-color: color-mix(in srgb, var(--accent-light) 72%, transparent);
        outline: 1px solid color-mix(in srgb, var(--accent-light) 56%, transparent);
        outline-offset: -1px;
        box-shadow: none;
      }
      .git-menu-theme-button.is-active:hover:not(:disabled) {
        color: var(--accent-light);
        background: color-mix(in srgb, var(--accent) 10%, transparent);
        border-color: color-mix(in srgb, var(--accent-light) 82%, transparent);
        outline-color: color-mix(in srgb, var(--accent-light) 70%, transparent);
      }
      .git-menu-theme-button:hover:not(:disabled) *,
      .git-menu-theme-button.is-active * {
        color: inherit !important;
      }
      .git-menu-theme-button:disabled {
        color: #71717a;
        background: transparent;
        border-color: transparent;
        box-shadow: none;
      }
      .git-menu-theme-button:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--accent-light) 70%, transparent);
        outline-offset: 2px;
      }
      .composer-toolbar-pill-button {
        color: #e4e4e7;
        background: transparent;
        border: 1px solid transparent;
        box-shadow: none;
      }
      .composer-toolbar-pill-button:hover:not(:disabled) {
        color: var(--accent-light);
        background: color-mix(in srgb, var(--accent) 16%, transparent);
        border-color: color-mix(in srgb, var(--accent-light) 30%, transparent);
      }
      .composer-toolbar-pill-button.is-active {
        color: var(--accent-light);
        background: transparent;
        border-color: color-mix(in srgb, var(--accent-light) 72%, transparent);
        outline: 1px solid color-mix(in srgb, var(--accent-light) 56%, transparent);
        outline-offset: -1px;
        box-shadow: none;
      }
      .composer-toolbar-pill-button.is-active:hover:not(:disabled) {
        color: var(--accent-light);
        background: color-mix(in srgb, var(--accent) 10%, transparent);
        border-color: color-mix(in srgb, var(--accent-light) 82%, transparent);
        outline-color: color-mix(in srgb, var(--accent-light) 70%, transparent);
      }
      .composer-toolbar-pill-button:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--accent-light) 70%, transparent);
        outline-offset: 2px;
      }
      .composer-toolbar-divider {
        background: rgba(255, 255, 255, 0.12);
      }
      html[data-theme="light"] .panel-tab-icon-button {
        color: var(--surface-text-muted);
      }
      html[data-theme="light"] .git-menu-theme-button {
        color: var(--surface-text-muted);
      }
      html[data-theme="light"] .panel-tab-icon-button:hover:not(:disabled) {
        color: color-mix(in srgb, var(--accent-hover), var(--surface-text-strong) 24%);
        background: color-mix(in srgb, var(--accent) 14%, var(--surface-2) 86%);
        border-color: color-mix(in srgb, var(--accent) 28%, var(--surface-2) 72%);
      }
      html[data-theme="light"] .git-menu-theme-button:hover:not(:disabled) {
        color: color-mix(in srgb, var(--accent-hover), var(--surface-text-strong) 24%);
        background: color-mix(in srgb, var(--accent) 14%, var(--surface-2) 86%);
        border-color: color-mix(in srgb, var(--accent) 28%, var(--surface-2) 72%);
      }
      html[data-theme="light"] .panel-tab-icon-button.is-active {
        color: color-mix(in srgb, var(--accent-hover), var(--surface-text-strong) 22%);
        background: transparent;
        border-color: color-mix(in srgb, var(--accent-hover) 62%, var(--surface-2) 38%);
        outline: 1px solid color-mix(in srgb, var(--accent-hover) 50%, var(--surface-2) 50%);
        outline-offset: -1px;
        box-shadow: none;
      }
      html[data-theme="light"] .git-menu-theme-button.is-active {
        color: color-mix(in srgb, var(--accent-hover), var(--surface-text-strong) 22%);
        background: transparent;
        border-color: color-mix(in srgb, var(--accent-hover) 62%, var(--surface-2) 38%);
        outline: 1px solid color-mix(in srgb, var(--accent-hover) 50%, var(--surface-2) 50%);
        outline-offset: -1px;
        box-shadow: none;
      }
      html[data-theme="light"] .panel-tab-icon-button.is-active:hover:not(:disabled) {
        color: color-mix(in srgb, var(--accent-hover), var(--surface-text-strong) 22%);
        background: color-mix(in srgb, var(--accent) 10%, var(--surface-2) 90%);
        border-color: color-mix(in srgb, var(--accent-hover) 72%, var(--surface-2) 28%);
        outline-color: color-mix(in srgb, var(--accent-hover) 62%, var(--surface-2) 38%);
      }
      html[data-theme="light"] .git-menu-theme-button.is-active:hover:not(:disabled) {
        color: color-mix(in srgb, var(--accent-hover), var(--surface-text-strong) 22%);
        background: color-mix(in srgb, var(--accent) 10%, var(--surface-2) 90%);
        border-color: color-mix(in srgb, var(--accent-hover) 72%, var(--surface-2) 28%);
        outline-color: color-mix(in srgb, var(--accent-hover) 62%, var(--surface-2) 38%);
      }
      html[data-theme="light"] .panel-tab-icon-button:disabled {
        color: var(--surface-text-subtle);
      }
      html[data-theme="light"] .git-menu-theme-button:disabled {
        color: var(--surface-text-subtle);
      }
      html[data-theme="light"] .composer-toolbar-pill-button {
        color: var(--surface-text);
      }
      html[data-theme="light"] .composer-toolbar-pill-button:hover:not(:disabled) {
        color: color-mix(in srgb, var(--accent-hover), var(--surface-text-strong) 24%);
        background: color-mix(in srgb, var(--accent) 14%, var(--surface-2) 86%);
        border-color: color-mix(in srgb, var(--accent) 28%, var(--surface-2) 72%);
      }
      html[data-theme="light"] .composer-toolbar-pill-button.is-active {
        color: color-mix(in srgb, var(--accent-hover), var(--surface-text-strong) 22%);
        background: transparent;
        border-color: color-mix(in srgb, var(--accent-hover) 62%, var(--surface-2) 38%);
        outline: 1px solid color-mix(in srgb, var(--accent-hover) 50%, var(--surface-2) 50%);
        outline-offset: -1px;
        box-shadow: none;
      }
      html[data-theme="light"] .composer-toolbar-pill-button.is-active:hover:not(:disabled) {
        color: color-mix(in srgb, var(--accent-hover), var(--surface-text-strong) 22%);
        background: color-mix(in srgb, var(--accent) 10%, var(--surface-2) 90%);
        border-color: color-mix(in srgb, var(--accent-hover) 72%, var(--surface-2) 28%);
        outline-color: color-mix(in srgb, var(--accent-hover) 62%, var(--surface-2) 38%);
      }
      html[data-theme="light"] .composer-toolbar-divider {
        background: rgba(15, 23, 42, 0.14);
      }
      html[data-theme="black"] .panel-tab-icon-button,
      html[data-theme="black"] .git-menu-theme-button,
      html[data-theme="black"] .composer-toolbar-pill-button {
        color: #a5a5ae;
      }
      html[data-theme="black"] .panel-tab-icon-button:hover:not(:disabled),
      html[data-theme="black"] .git-menu-theme-button:hover:not(:disabled),
      html[data-theme="black"] .composer-toolbar-pill-button:hover:not(:disabled) {
        color: var(--accent-light);
        background: color-mix(in srgb, var(--accent) 12%, #000000 88%);
        border-color: color-mix(in srgb, var(--accent-light) 26%, transparent);
      }
      html[data-theme="black"] .panel-tab-icon-button.is-active,
      html[data-theme="black"] .git-menu-theme-button.is-active,
      html[data-theme="black"] .composer-toolbar-pill-button.is-active {
        color: var(--accent-light);
        background: rgba(255,255,255,0.02);
        border-color: color-mix(in srgb, var(--accent-light) 68%, transparent);
        outline-color: color-mix(in srgb, var(--accent-light) 48%, transparent);
      }
      html[data-theme="black"] .composer-toolbar-divider {
        background: rgba(255, 255, 255, 0.08);
      }
    `}</style>
  );
}
