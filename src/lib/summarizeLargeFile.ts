import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "./appTypes";
import { type ProtocolChatMessage } from "./cloudProtocol";
import { invokeModelWithMessages, type GenerateGitCommitMessageParams } from "./gitCommitMessage";

export interface LargeFileSummaryResult {
  content: string;
  summarized: boolean;
  reason: "summarized" | "below_chunk_threshold" | "read_failed";
}

export async function summarizeLargeFile(
  path: string,
  workspace: string,
  sessionKey: string | undefined,
  config: AppConfig,
): Promise<LargeFileSummaryResult> {
  // Read full file by bypassing window limits
  let content = "";
  try {
    content = await invoke<string>("read_file", { path, workspace, sessionKey });
  } catch (e) {
    return {
      content: `[FILE MAP-REDUCE SUMMARY ERROR]\nError reading full file for summarization: ${e}`,
      summarized: false,
      reason: "read_failed",
    };
  }

  // Chunking
  const CHUNK_SIZE = 40000;
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    chunks.push(content.slice(i, i + CHUNK_SIZE));
  }

  if (chunks.length === 1) {
    // Preserve the original READ_FILE_RESULT window in the caller. Returning
    // raw content here used to discard nextStartLine and then hit the generic
    // model-output character cap for files between that cap and CHUNK_SIZE.
    return {
      content,
      summarized: false,
      reason: "below_chunk_threshold",
    };
  }

  const params: GenerateGitCommitMessageParams = {
    workspace,
    language: "en",
    entries: [],
    config: config as any,
  };

  // Map
  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const messages: ProtocolChatMessage[] = [
      {
        role: "system",
        content: `You are an expert code analyst. Summarize this file chunk (${i + 1}/${chunks.length}). Focus on classes, functions, and key logic.`
      },
      {
        role: "user",
        content: chunk
      }
    ];
    try {
      const summary = await invokeModelWithMessages(params, messages);
      chunkSummaries.push(`--- Chunk ${i + 1}/${chunks.length} Summary ---\n${summary || "No summary generated."}`);
    } catch (e) {
      chunkSummaries.push(`--- Chunk ${i + 1}/${chunks.length} Summary ---\nError generating summary: ${e}`);
    }
  }

  // Reduce
  const combined = chunkSummaries.join("\n\n");
  const reduceMessages: ProtocolChatMessage[] = [
    {
      role: "system",
      content: `You are an expert code analyst. Synthesize these chunk summaries into a single comprehensive file summary.`
    },
    {
      role: "user",
      content: combined
    }
  ];

  try {
    const finalSummary = await invokeModelWithMessages(params, reduceMessages);
    return {
      content: `[FILE MAP-REDUCE SUMMARY]\nThis file was too large and was automatically summarized via Map-Reduce.\n\n${finalSummary || combined}`,
      summarized: true,
      reason: "summarized",
    };
  } catch (e) {
    return {
      content: `[FILE MAP-REDUCE SUMMARY]\n${combined}\n\n(Error during final reduce: ${e})`,
      summarized: true,
      reason: "summarized",
    };
  }
}
