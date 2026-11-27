import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { useActiveThemePalette } from "./useThemePalette";

let mermaidModulePromise: Promise<typeof import("mermaid")["default"]> | null = null;
let mermaidRenderId = 0;
const mermaidSvgCache = new Map<string, { svg: string; bindFunctions?: (element: Element) => void }>();

function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid").then((module) => module.default);
  }
  return mermaidModulePromise;
}

export default function MermaidBlock({ code, expanded = false }: { code: string; expanded?: boolean }) {
  const themePalette = useActiveThemePalette();
  const language = useAppStore((s) => s.config.language);
  const containerRef = useRef<HTMLDivElement>(null);
  const bindFunctionsRef = useRef<((element: Element) => void) | undefined>(undefined);
  const requestIdRef = useRef(0);
  const source = useMemo(() => code.trim(), [code]);
  const cacheKey = `${themePalette.signature}::${source}`;
  const [svg, setSvg] = useState(() => mermaidSvgCache.get(cacheKey)?.svg || "");
  const [isRendering, setIsRendering] = useState(() => Boolean(source) && !mermaidSvgCache.has(cacheKey));
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    const cached = mermaidSvgCache.get(cacheKey);

    if (!source) {
      setSvg("");
      setError("");
      setIsRendering(false);
      bindFunctionsRef.current = undefined;
      return;
    }

    if (cached) {
      bindFunctionsRef.current = cached.bindFunctions;
      setSvg(cached.svg);
      setError("");
      setIsRendering(false);
      return;
    }

    const currentRequestId = ++requestIdRef.current;
    setError("");
    setIsRendering(true);

    const render = async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: "base",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          themeVariables: themePalette.mermaidThemeVariables,
        });

        const { svg: renderedSvg, bindFunctions } = await mermaid.render(
          `mermaid-diagram-${++mermaidRenderId}`,
          source,
        );

        if (disposed || requestIdRef.current !== currentRequestId) return;
        mermaidSvgCache.set(cacheKey, { svg: renderedSvg, bindFunctions: bindFunctions ?? undefined });
        bindFunctionsRef.current = bindFunctions ?? undefined;
        setSvg(renderedSvg);
        setError("");
        setIsRendering(false);
      } catch (err) {
        if (disposed || requestIdRef.current !== currentRequestId) return;
        bindFunctionsRef.current = undefined;
        setSvg("");
        setError(err instanceof Error ? err.message : String(err));
        setIsRendering(false);
      }
    };

    const timerId = window.setTimeout(render, 180);

    return () => {
      disposed = true;
      window.clearTimeout(timerId);
    };
  }, [cacheKey, source, themePalette.mermaidThemeVariables]);

  useEffect(() => {
    if (!svg || !containerRef.current) return;

    const svgElement = containerRef.current.querySelector("svg");
    if (svgElement instanceof SVGElement) {
      svgElement.style.display = "block";
      svgElement.style.maxWidth = "100%";
      svgElement.style.height = "auto";
      svgElement.style.margin = "0 auto";
    }

    bindFunctionsRef.current?.(containerRef.current);
  }, [svg]);

  if (error) {
    return (
      <div className="space-y-3 p-4">
        <div
          className="rounded-xl border px-4 py-3 text-[12px] leading-6"
          style={{
            borderColor: "rgba(248,113,113,0.28)",
            backgroundColor: "rgba(127,29,29,0.12)",
            color: "#fca5a5",
          }}
        >
          {(language === "en" ? "Mermaid render failed: " : "Mermaid 渲染失败：") + error}
        </div>
        <pre
          className="overflow-x-auto rounded-xl border p-4 font-mono text-[12px] leading-6"
          style={{
            borderColor: "var(--surface-border-soft, #2c2c32)",
            backgroundColor: "var(--surface-1, #1d1d20)",
            color: "var(--surface-text, #e4e4e7)",
          }}
        >
          {code}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="p-4">
        <div
          className={`flex items-center justify-center rounded-xl border px-4 text-[12px] ${expanded ? "min-h-[520px] py-12" : "min-h-[220px] py-10"}`}
          style={{
            borderColor: "var(--surface-border-soft, #2c2c32)",
            background: "linear-gradient(135deg, rgba(124,58,237,0.08), rgba(59,130,246,0.04))",
            color: "var(--surface-text-muted, #b0b0ba)",
          }}
        >
          {error
            ? (language === "en" ? "Mermaid render failed." : "Mermaid 渲染失败。")
            : isRendering
            ? (language === "en" ? "Rendering Mermaid diagram..." : "正在渲染 Mermaid 图表...")
            : (language === "en" ? "Diagram unavailable." : "图表暂不可用。")}
        </div>
      </div>
    );
  }

  return (
    <div className={`${expanded ? "h-full overflow-auto p-6" : "overflow-x-auto p-4"}`}>
      <div
        ref={containerRef}
        className={expanded ? "mx-auto min-w-[760px]" : undefined}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
