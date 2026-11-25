export const SIDEBAR_CHAT_HEIGHT_STORAGE_KEY = "main.sidebar.chatSectionHeight";
export const DEFAULT_SIDEBAR_CHAT_HEIGHT = 220;
export const MIN_SIDEBAR_CHAT_HEIGHT = 96;
export const MAX_SIDEBAR_CHAT_HEIGHT_FALLBACK = 640;
export const MIN_SIDEBAR_WORKSPACE_HEIGHT = 120;
const SIDEBAR_CHAT_HEADER_RESERVE_PX = 44;

export function clampSidebarChatSectionHeight(
  requestedHeight: number,
  containerHeight?: number | null,
): number {
  const numeric = Number.isFinite(requestedHeight)
    ? Math.round(requestedHeight)
    : DEFAULT_SIDEBAR_CHAT_HEIGHT;
  const maxAllowed =
    typeof containerHeight === "number" &&
    Number.isFinite(containerHeight) &&
    containerHeight > MIN_SIDEBAR_WORKSPACE_HEIGHT + MIN_SIDEBAR_CHAT_HEIGHT + SIDEBAR_CHAT_HEADER_RESERVE_PX
      ? Math.max(
          MIN_SIDEBAR_CHAT_HEIGHT,
          Math.floor(containerHeight - MIN_SIDEBAR_WORKSPACE_HEIGHT - SIDEBAR_CHAT_HEADER_RESERVE_PX),
        )
      : MAX_SIDEBAR_CHAT_HEIGHT_FALLBACK;
  return Math.min(maxAllowed, Math.max(MIN_SIDEBAR_CHAT_HEIGHT, numeric));
}

export function readStoredSidebarChatSectionHeight(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_CHAT_HEIGHT_STORAGE_KEY);
    if (!raw) return DEFAULT_SIDEBAR_CHAT_HEIGHT;
    const parsed = Number(raw);
    return Number.isFinite(parsed)
      ? clampSidebarChatSectionHeight(parsed)
      : DEFAULT_SIDEBAR_CHAT_HEIGHT;
  } catch {
    return DEFAULT_SIDEBAR_CHAT_HEIGHT;
  }
}
