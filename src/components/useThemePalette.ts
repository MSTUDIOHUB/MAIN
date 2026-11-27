import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import {
  deriveThemePalette,
  resolveEffectiveThemeMode,
  type DerivedThemePalette,
  type ResolvedThemeMode,
} from "../lib/themePresets";

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: light)";

function readSystemPrefersLight(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(COLOR_SCHEME_QUERY).matches;
}

export function useSystemPrefersLight(): boolean {
  const [prefersLight, setPrefersLight] = useState<boolean>(() => readSystemPrefersLight());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY);
    setPrefersLight(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersLight(event.matches);
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  return prefersLight;
}

export function useEffectiveThemeMode(): ResolvedThemeMode {
  const themeMode = useAppStore((s) => s.config.themeMode);
  const systemPrefersLight = useSystemPrefersLight();
  return resolveEffectiveThemeMode(themeMode, systemPrefersLight);
}

export function useActiveThemePalette(): DerivedThemePalette {
  const themeMode = useAppStore((s) => s.config.themeMode);
  const lightTheme = useAppStore((s) => s.config.lightTheme);
  const darkTheme = useAppStore((s) => s.config.darkTheme);
  const blackTheme = useAppStore((s) => s.config.blackTheme);
  const legacyThemeKey = useAppStore((s) => s.config.theme);
  const systemPrefersLight = useSystemPrefersLight();

  const effectiveMode = resolveEffectiveThemeMode(themeMode, systemPrefersLight);

  return useMemo(
    () =>
      deriveThemePalette({
        effectiveMode,
        lightTheme,
        darkTheme,
        blackTheme,
        legacyThemeKey,
      }),
    [effectiveMode, lightTheme, darkTheme, blackTheme, legacyThemeKey],
  );
}
