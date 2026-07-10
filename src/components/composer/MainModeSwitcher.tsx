import { useState, type RefObject } from "react";
import type { MainModeKey } from "../../lib/mainModes";
import { IconChevronUp } from "../Icons";

type Props = {
  pickerRef: RefObject<HTMLDivElement | null>;
  isOpen: boolean;
  selectedModeKey: MainModeKey;
  modeKeys: readonly MainModeKey[];
  modeLabels: Record<MainModeKey, string>;
  modeDescriptions: Record<MainModeKey, string>;
  switchLabel: string;
  themeMode: "light" | "dark" | "black";
  onOpenChange: (open: boolean) => void;
  onSelect: (modeKey: MainModeKey) => void | Promise<void>;
};

export default function MainModeSwitcher({
  pickerRef,
  isOpen,
  selectedModeKey,
  modeKeys,
  modeLabels,
  modeDescriptions,
  switchLabel,
  themeMode,
  onOpenChange,
  onSelect,
}: Props) {
  const [hoveredModeKey, setHoveredModeKey] = useState<MainModeKey | null>(null);
  const isLightTheme = themeMode === "light";
  const menuPanelClass = isLightTheme
    ? "absolute bottom-full left-0 z-[60] mb-2 w-72 overflow-hidden rounded-xl border bg-white"
    : "absolute bottom-full left-0 z-[60] mb-2 w-72 overflow-hidden rounded-xl border bg-[#09090b]";
  const menuHeaderClass = isLightTheme
    ? "border-b border-[#e4e4e7] text-[#52525b]"
    : "border-b border-[#27272a] text-[#a1a1aa]";
  const selectedTextStyle = {
    color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)",
  };
  const neutralTitleStyle = {
    color: isLightTheme ? "#18181b" : "#e4e4e7",
  };
  const neutralBodyStyle = {
    color: isLightTheme ? "#52525b" : "#71717a",
  };

  const handleSelect = async (modeKey: MainModeKey) => {
    await onSelect(modeKey);
    onOpenChange(false);
    setHoveredModeKey(null);
  };

  return (
    <div className="relative" ref={pickerRef}>
      <button
        type="button"
        data-testid="main-focus-picker-button"
        onClick={() => {
          onOpenChange(!isOpen);
          setHoveredModeKey(null);
        }}
        className={`composer-toolbar-pill-button flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[11px] font-bold transition-all duration-150 ${isOpen ? "is-active" : ""}`}
      >
        <span className="max-w-[112px] truncate">{modeLabels[selectedModeKey]}</span>
        <IconChevronUp className="h-3.5 w-3.5" />
      </button>

      {isOpen && (
        <div
          className={menuPanelClass}
          style={{ borderColor: "var(--accent-subtle-border)" }}
          onMouseLeave={() => setHoveredModeKey(null)}
        >
          <div className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider ${menuHeaderClass}`}>
            {switchLabel}
          </div>
          {modeKeys.map((modeKey) => {
            const isSelected = selectedModeKey === modeKey;
            const isHovered = hoveredModeKey === modeKey;
            return (
              <button
                key={modeKey}
                type="button"
                data-testid={`main-focus-option-${modeKey}`}
                onMouseMove={() => setHoveredModeKey(modeKey)}
                onClick={() => void handleSelect(modeKey)}
                style={isSelected || isHovered ? { backgroundColor: "var(--accent-subtle)" } : undefined}
                className="w-full px-3 py-2.5 text-left transition-colors"
              >
                <div
                  className="text-[12px] font-semibold"
                  style={isSelected ? selectedTextStyle : neutralTitleStyle}
                >
                  {modeLabels[modeKey]}
                </div>
                <div
                  className="mt-0.5 text-[11px] leading-snug"
                  style={isSelected ? selectedTextStyle : neutralBodyStyle}
                >
                  {modeDescriptions[modeKey]}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
