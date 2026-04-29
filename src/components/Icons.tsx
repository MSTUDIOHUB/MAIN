// @ts-nocheck
import React from "react";

export const createIcon = (svgContent) => ({ className, ...props }) => (
  <svg {...props} className={className ? `shrink-0 ${className}` : "shrink-0 w-4 h-4"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {svgContent}
  </svg>
);

export const IconFile = createIcon(<><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" /></>);
export const IconCheck = createIcon(<polyline points="20 6 9 17 4 12" />);
export const IconSettings = createIcon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></>);
export const IconTerminal = createIcon(<><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>);
export const IconColumns = createIcon(<><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="12" y1="3" x2="12" y2="21" /></>);
export const IconClose = createIcon(<><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>);
export const IconImageIcon = createIcon(<><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></>);
export const IconAgent = createIcon(<path d="M12 2a2 2 0 0 1 2 2c0 1.1-.9 2-2 2s-2-.9-2-2a2 2 0 0 1 2-2zm0 6c2.67 0 8 1.34 8 4v2H4v-2c0-2.66 5.33-4 8-4z" />);
export const IconChat = createIcon(<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></>);
export const IconCloud = createIcon(<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />);
export const IconChevronUp = createIcon(<polyline points="18 15 12 9 6 15" />);
export const IconChevronDown = createIcon(<polyline points="6 9 12 15 18 9" />);
export const IconChevronRight = createIcon(<polyline points="9 18 15 12 9 6" />);
export const IconCode = createIcon(<><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>);
export const IconAt = createIcon(<><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" /></>);
export const IconPlus = createIcon(<><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>);
export const IconArrowUp = createIcon(<><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></>);
export const IconExpand = createIcon(<><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>);
export const IconSearch = createIcon(<><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>);
export const IconTrash = createIcon(<><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>);
export const IconShield = createIcon(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />);
export const IconBook = createIcon(<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>);
export const IconZap = createIcon(<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />);
export const IconFileText = createIcon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></>);
export const IconFileCode = createIcon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><polyline points="10 13 8 15 10 17" /><polyline points="14 13 16 15 14 17" /></>);
export const IconFileMarkdown = createIcon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><polyline points="7 17 7 12 10 15 13 12 13 17" /><line x1="16" y1="12" x2="16" y2="17" /><polyline points="14.5 15.5 16 17 17.5 15.5" /></>);
export const IconFileJson = createIcon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><path d="M9 12c-1 0-1.5.7-1.5 1.5S7 15 6 15c1 0 1.5.7 1.5 1.5S8 18 9 18" /><path d="M15 12c1 0 1.5.7 1.5 1.5S17 15 18 15c-1 0-1.5.7-1.5 1.5S16 18 15 18" /></>);
export const IconFileStyle = createIcon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><path d="M12 12s-3 3.1-3 5a3 3 0 0 0 6 0c0-1.9-3-5-3-5z" /></>);
export const IconFileConfig = createIcon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="12" x2="16" y2="12" /><circle cx="10" cy="12" r="1" fill="currentColor" stroke="none" /><line x1="8" y1="16" x2="16" y2="16" /><circle cx="14" cy="16" r="1" fill="currentColor" stroke="none" /></>);
export const IconFileTable = createIcon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><rect x="7" y="12" width="10" height="6" rx="1" /><line x1="7" y1="15" x2="17" y2="15" /><line x1="10.5" y1="12" x2="10.5" y2="18" /><line x1="14" y1="12" x2="14" y2="18" /></>);
export const IconFileArchive = createIcon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="11" y1="10" x2="11" y2="19" /><line x1="13" y1="12" x2="11" y2="12" /><line x1="13" y1="15" x2="11" y2="15" /><line x1="13" y1="18" x2="11" y2="18" /></>);
export const IconFileAudio = createIcon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><path d="M10 18a2 2 0 1 1 0-4" /><path d="M12 18V12l5-1v5" /><path d="M15 17a2 2 0 1 0 2-2" /></>);
export const IconFileVideo = createIcon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><polygon points="10 12 16 15 10 18 10 12" /></>);
export const IconSave = createIcon(<><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></>);
export const IconTool = createIcon(<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />);
export const IconStop = createIcon(<rect x="6" y="6" width="12" height="12" rx="1" />);
export const IconPlay = createIcon(<polygon points="8 5 19 12 8 19 8 5" />);
export const IconRefresh = createIcon(<><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" /><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" /></>);
export const IconTrash2 = createIcon(<><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></>);
export const IconLock = createIcon(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 1 1 8 0v3" /></>);
export const IconUnlock = createIcon(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.6-1.8" /></>);
export const IconLogoM = ({ className, style, ...props }) => (
  <svg {...props} className={className ? `shrink-0 ${className}` : "shrink-0 w-6 h-6"} viewBox="150 190 220 150" fill="currentColor" style={style}>
    <path d="M323.961 212.5V307L297.98 322V243.983L258.98 266.5L219.98 243.983V322L194 307V212.5L206.99 205L258.98 235.017L310.971 205L323.961 212.5Z" />
  </svg>
);
export const IconFolder = createIcon(<><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></>);
export const IconFolderOpen = createIcon(<><path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v2" /><path d="M2 11h20l-2 8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>);
export const IconEdit = createIcon(<><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></>);
export const IconPackage = createIcon(<><line x1="16.5" y1="9.4" x2="7.5" y2="4.21" /><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></>);
