import type { RefObject } from "react";
import type { SlashCommandCatalogItem } from "../../lib/gameStudio/catalog";
import type { MainIntentShortcutItem } from "../../lib/runIntent";
import { IconCode } from "../Icons";

export type GameStudioSlashMenuItem =
  | SlashCommandCatalogItem
  | (MainIntentShortcutItem & {
      id: string;
      kind: "main_intent";
      group: string;
    });

export type GameStudioSlashMenuSection = {
  heading: string;
  groups: Array<[string, GameStudioSlashMenuItem[]]>;
};

type Props = {
  menuRef: RefObject<HTMLDivElement | null>;
  searchLabel: string;
  commandLabel: string;
  emptyLabel: string;
  hint: string;
  navigationHint: string;
  selectHint: string;
  closeHint: string;
  planKindLabel: string;
  workflowKindLabel: string;
  agentKindLabel: string;
  highlightedIndex: number;
  sections: GameStudioSlashMenuSection[];
  onSelect: (item: GameStudioSlashMenuItem) => void;
};

export default function GameStudioSlashMenu({
  menuRef,
  searchLabel,
  commandLabel,
  emptyLabel,
  hint,
  navigationHint,
  selectHint,
  closeHint,
  planKindLabel,
  workflowKindLabel,
  agentKindLabel,
  highlightedIndex,
  sections,
  onSelect,
}: Props) {
  const hasItems = sections.some((section) => section.groups.some(([, items]) => items.length > 0));
  let globalIndex = -1;

  return (
    <div
      ref={menuRef}
      className="absolute bottom-full left-4 z-50 mb-1 flex w-[min(36rem,calc(100%-2rem))] max-w-[36rem] flex-col overflow-hidden rounded-lg border border-[#27272a] bg-[#09090b]"
    >
      <div className="flex items-center gap-2 border-b border-[#27272a] bg-[#000000] p-2 text-[#e4e4e7]">
        <IconCode className="h-3.5 w-3.5 text-[#86efac]" />
        <span className="truncate text-[11px] text-[#a1a1aa]">{searchLabel}</span>
        <span className="ml-auto text-[10px] text-[#52525b]">{commandLabel}</span>
      </div>

      <div className="max-h-72 overflow-y-auto px-2 py-2">
        {!hasItems ? (
          <div className="px-3 py-4 text-center text-[11px] text-[#a1a1aa]">{emptyLabel}</div>
        ) : (
          sections.map((section) => (
            <div key={section.heading} className="mb-2 last:mb-0">
              <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#71717a]">
                {section.heading}
              </div>
              {section.groups.map(([groupName, items]) => (
                <div key={`${section.heading}-${groupName}`} className="mb-1 last:mb-0">
                  <div className="px-2 pb-1 pt-1 text-[10px] text-[#52525b]">{groupName}</div>
                  {items.map((item) => {
                    globalIndex += 1;
                    const isActive = globalIndex === highlightedIndex;
                    const itemTitle = item.kind === "workflow"
                      ? item.canonicalCommand
                      : item.kind === "main_intent"
                      ? item.command
                      : item.label;
                    const itemKindLabel = item.kind === "workflow"
                      ? workflowKindLabel
                      : item.kind === "main_intent"
                      ? planKindLabel
                      : agentKindLabel;

                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onSelect(item)}
                        className={`w-full rounded-md px-3 py-2 text-left transition-colors ${
                          isActive ? "bg-[#18181b]" : "hover:bg-[#131316]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-[12px] font-semibold text-[#f4f4f5]">
                              {itemTitle}
                            </div>
                            <div className="mt-0.5 text-[11px] leading-snug text-[#71717a]">
                              {item.description}
                            </div>
                          </div>
                          <div className="shrink-0 rounded-full border border-[#27272a] bg-[#050507] px-2 py-0.5 text-[10px] text-[#a1a1aa]">
                            {itemKindLabel}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-[#27272a] px-3 py-1.5 text-[10px] text-[#52525b]">
        <span>{navigationHint}</span>
        <span>{selectHint}</span>
        <span>{closeHint}</span>
        <span className="ml-auto">{hint}</span>
      </div>
    </div>
  );
}
