import { useAppStore, useTheme } from "../store/useAppStore";

interface ThoughtBlockProps {
  content: string;
  isStreaming?: boolean;
  duration?: number;
}

export default function ThoughtBlock({
  isStreaming = false,
}: ThoughtBlockProps) {
  const theme = useTheme();
  const language = useAppStore((s) => s.config.language);
  const themeMode = useAppStore((s) => s.config.themeMode);
  const isLightTheme = themeMode === "light";
  const isBlackTheme = themeMode === "black";

  const label = language === "zh" ? "思考中" : "Thinking";

  return (
    <div className="w-full ml-9 mt-1 mb-2">
      <div
        className="inline-flex items-center gap-2 rounded-md border px-3 py-2 font-mono text-[11px] shadow-sm"
        style={{
          color: isStreaming ? theme.light : isLightTheme ? "#52525b" : isBlackTheme ? "#a5a5ae" : "#a1a1aa",
          backgroundColor: isLightTheme ? "#ffffff" : isBlackTheme ? "#030304" : "#07070a",
          borderColor: isStreaming ? theme.subtleBorder : isLightTheme ? "#d4d4d8" : isBlackTheme ? "#202026" : "#27272a",
        }}
      >
        <span
          className="h-1.5 w-1.5 rounded-full shrink-0"
          style={{
            backgroundColor: theme.accent,
            boxShadow: isStreaming ? `0 0 8px ${theme.light}` : undefined,
            animation: isStreaming ? "pulse 1.5s ease-in-out infinite" : undefined,
          }}
        />
        <span className="italic">{label}</span>
      </div>
    </div>
  );
}
