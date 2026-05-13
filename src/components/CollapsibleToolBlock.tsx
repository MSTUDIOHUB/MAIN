// @ts-nocheck
import React, { useState } from "react";
import { IconChevronUp, IconChevronDown, IconTool, IconCheck } from "./Icons";
import { useAppStore } from "../store/useAppStore";
import { formatToolPresentation } from "../lib/toolPresentation";
import { sanitizeAIOutput, stripAnsi } from "../lib/sanitize";

export default function CollapsibleToolBlock({ toolName, target, message, status }) {
  const [expanded, setExpanded] = useState(false);
  const language = useAppStore((s) => s.config.language) === "en" ? "en" : "zh";
  const presentation = formatToolPresentation({ toolName, target, language });
  const isTerminal = toolName === "execute_command" || toolName === "send_pty_input" || toolName === "run_command" || toolName === "read_pty_buffer" || toolName === "read_pty_tail" || toolName === "read_pty_since" || toolName === "get_pty_status" || toolName === "clear_pty_buffer";
  const cleanMessage = isTerminal ? stripAnsi(String(message || "")) : sanitizeAIOutput(String(message || ""));
  return (
    <div className="w-full flex flex-col gap-1.5 max-w-3xl ml-9 mt-1 mb-2">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 font-mono text-[11px] text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors w-max bg-[#09090b] px-2.5 py-1.5 rounded border border-[#27272a] shadow-sm">
        {expanded ? <IconChevronDown className="w-3.5 h-3.5" /> : <IconChevronUp className="w-3.5 h-3.5 rotate-90" />}
        <IconTool className="text-[#a1a1aa] w-3.5 h-3.5" />
        <span>
          <b className="text-[#d4d4d8] font-semibold">{presentation.label}</b>
          {language === "zh" ? "：" : ": "}
          {presentation.target}
        </span>
        {status === 'done' && <IconCheck className="text-[#86d9a3] w-3.5 h-3.5 ml-1" />}
      </button>
      {expanded && (
        <div className="bg-[#000000] border border-[#27272a] rounded-md p-3 font-mono text-[11px] text-[#d4d4d8] shadow-inner ml-2">
          <div className="opacity-70 mb-1">{presentation.summary}</div>
          <div className="text-[#86d9a3]">{cleanMessage}</div>
        </div>
      )}
    </div>
  );
}
