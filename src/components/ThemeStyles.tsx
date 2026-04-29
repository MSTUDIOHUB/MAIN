import { useEffect } from "react";
import { useAppStore } from "../store/useAppStore";

export default function ThemeStyles() {
  const themeMode = useAppStore((s) => s.config.themeMode);

  // Mount data-theme attribute on <html> for CSS overrides
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", themeMode || "dark");
  }, [themeMode]);

  return (
    <style>{`
      :root { --inline-chip-text: #f5f5f5; }
      html[data-theme="light"] { --inline-chip-text: #09090b; }
      .theme-bg { background-color: var(--accent) !important; color: white !important; }
      .theme-bg-hover:hover { background-color: var(--accent-hover) !important; color: white !important; }
      .theme-text { color: var(--accent-light) !important; }
      .theme-border { border-color: var(--accent) !important; }
      .theme-subtle-bg { background-color: var(--accent-subtle) !important; color: var(--accent-light) !important; }
      .theme-subtle-border { border-color: var(--accent-subtle-border) !important; }
      .theme-glow { box-shadow: 0 0 8px var(--accent-subtle) !important; }
      .theme-slider { accent-color: var(--accent) !important; }
      .theme-ring:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
      html[data-theme="light"] .theme-text { color: color-mix(in srgb, var(--accent-hover), #111827 28%) !important; }
      html[data-theme="light"] .theme-subtle-bg { color: color-mix(in srgb, var(--accent-hover), #111827 28%) !important; }
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
      html[data-theme="light"] .panel-tab-icon-button {
        color: #52525b;
      }
      html[data-theme="light"] .panel-tab-icon-button:hover:not(:disabled) {
        color: color-mix(in srgb, var(--accent-hover), #111827 24%);
        background: color-mix(in srgb, var(--accent) 14%, #ffffff 86%);
        border-color: color-mix(in srgb, var(--accent) 28%, #ffffff 72%);
      }
      html[data-theme="light"] .panel-tab-icon-button.is-active {
        color: color-mix(in srgb, var(--accent-hover), #111827 22%);
        background: transparent;
        border-color: color-mix(in srgb, var(--accent-hover) 62%, #ffffff 38%);
        outline: 1px solid color-mix(in srgb, var(--accent-hover) 50%, #ffffff 50%);
        outline-offset: -1px;
        box-shadow: none;
      }
      html[data-theme="light"] .panel-tab-icon-button.is-active:hover:not(:disabled) {
        color: color-mix(in srgb, var(--accent-hover), #111827 22%);
        background: color-mix(in srgb, var(--accent) 10%, #ffffff 90%);
        border-color: color-mix(in srgb, var(--accent-hover) 72%, #ffffff 28%);
        outline-color: color-mix(in srgb, var(--accent-hover) 62%, #ffffff 38%);
      }
      html[data-theme="light"] .panel-tab-icon-button:disabled {
        color: #a1a1aa;
      }
    `}</style>
  );
}
