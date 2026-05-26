export type ChatLanguage = "zh" | "en";

export type ChatBlockKind =
  | "user"
  | "agent"
  | "assistant"
  | "tool"
  | "thought"
  | "system"
  | "progress"
  | "job_list"
  | "context_compression"
  | string;

export type ChatBlock = {
  id?: string;
  kind?: ChatBlockKind;
  type?: string;
  role?: string;
  content?: string;
  text?: string;
  status?: string;
  timestamp?: number;
  [key: string]: unknown;
};
