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
    `}</style>
  );
}
