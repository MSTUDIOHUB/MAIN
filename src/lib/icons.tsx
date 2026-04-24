// lib/icons.tsx
// All SVG icons from the UI reference — zero external icon libraries needed.
// Each icon is a tiny factory-produced React component.
import React from "react";

type IconProps = React.SVGProps<SVGSVGElement> & { className?: string };

const createIcon = (svgContent: React.ReactNode) =>
  function Icon({ className, ...props }: IconProps) {
    return (
      <svg
        {...props}
        className={className ? `shrink-0 ${className}` : "shrink-0 w-4 h-4"}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {svgContent}
      </svg>
    );
  };

export const IconFile = createIcon(<><path d="M13 2H6a2 2 0 0-2 2v16a2 2 0 0 2 2h12a2 2 0 0 2 2-2V9z"/><polyline points="13 2 13 9 20 9"/></>);
export const IconCheck = createIcon(<polyline points="20 6 9 17 4 12"/>);
export const IconSettings = createIcon(<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82-.33 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0 1 1.51 1z"/></>);
export const IconTerminal = createIcon(<><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></>);
export const IconColumns = createIcon(<><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="3" x2="12" y2="21"/></>);
export const IconClose = createIcon(<><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>);
export const IconImageIcon = createIcon(<><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></>);
export const IconAgent = createIcon(<path d="M12 2a2 2 0 0 1 2 2c0 1.1-.9 2-2 2s-2-.9-2-2a2 2 0 0 1 2-2zm0 6c2.67 0 8 1.34 8 4v2H4v-2c0-2.66 5.33-4 8-4z"/>);
export const IconChat = createIcon(<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></>);
export const IconCloud = createIcon(<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>);
export const IconChevronUp = createIcon(<polyline points="18 15 12 9 6 15"/>);
export const IconChevronDown = createIcon(<polyline points="6 9 12 15 18 9"/>);
export const IconCode = createIcon(<><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></>);
export const IconAt = createIcon(<><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></>);
export const IconPlus = createIcon(<><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>);
export const IconArrowUp = createIcon(<><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></>);
export const IconSearch = createIcon(<><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>);
export const IconTrash = createIcon(<><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2-2v2"/></>);
export const IconBook = createIcon(<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></>);
export const IconTool = createIcon(<path d="M14.7 6.3a1 1 0 0 0 1.4l1.6 1.6a1 1 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>);

// Folder open icon (for selecting workspace folder)
export const IconFolderOpen = createIcon(
  <>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 2 2v16a2 2 0 0 1 2 2h12a2 2 0 0 1 2 2v-9a2 2 0 0 1 2 2h12a2 2 0 0 1 2 2z" />
    <path d="M2 13a2 2 0 0 1 2 2v8a2 2 0 0 1 2 2H4a2 2 0 0 1 2 2v8a2 2 0 0 1 2 2z" />
    <polyline points="2 13 9 13 9 4" />
    <polyline points="22 13 15 13 15 11" />
    <polyline points="22 13 15 4 15 4 11" />
  </>
);

// Stop / Square icon (for abort generation button)
export const IconSquare = createIcon(<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>);
