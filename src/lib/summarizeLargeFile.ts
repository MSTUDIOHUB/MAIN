import { invoke } from "@tauri-apps/api/core";
import { type AppConfig } from "../store/useAppStore";
import { type ProtocolChatMessage } from "./cloudProtocol";
import { invokeModelWithMessages, type GenerateGitCommitMessageParams } from "./gitCommitMessage";

export async function summarizeLargeFile(
  path: string,
  workspace: string,
  sessionKey: string | undefined,
  config: AppConfig,
): Promise<string> {
  // Read full file by bypassing window limits
  let content = "";
  try {
    content = await invoke<string>("read_file", { path, workspace, sessionKey });
  } catch (e) {
    return `[FILE MAP-REDUCE SUMMARY ERROR]\nError reading full file for summarization: ${e}`;
  }

  // Chunking
  const CHUNK_SIZE = 40000;
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    chunks.push(content.slice(i, i + CHUNK_SIZE));
  }

  if (chunks.length === 1) {
    // Should not happen if this is only called for large files, but just in case
    return content;
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
    return `[FILE MAP-REDUCE SUMMARY]\nThis file was too large and was automatically summarized via Map-Reduce.\n\n${finalSummary || combined}`;
  } catch (e) {
    return `[FILE MAP-REDUCE SUMMARY]\n${combined}\n\n(Error during final reduce: ${e})`;
  }
}
