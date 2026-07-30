import type { AttachedFile } from "./attachments";
import type { CloudToolProtocol, ReasoningDisplayMode } from "./cloudProtocol";
import type { CloudProfileConfig, CloudServerConfig } from "./cloudServers";
import type { ImAdaptersConfig } from "./imAdapters";
import type {
  McpRoutingConfig,
  PromptLanguageStrategy,
  ToolPermissionPolicy,
} from "./toolCapabilities";
import type { EventStreamMode, ToolFeedbackFormat } from "./turnEvents";
import type { ResponseLanguagePolicy } from "./workflowModels";

export type Lang = "en" | "zh";

export type ThemeMode = "light" | "dark" | "black";

export type ThemeKey =
  | "blue"
  | "purple"
  | "green"
  | "yellow"
  | "rose"
  | "hermesOrange"
  | "tiffanyBlue";

export interface Skill {
  id: string;
  name: string;
  desc: string;
  content: string;
  active: boolean;
  isBuiltIn?: boolean;
  type?: "instruction" | "tool" | "package";
  toolParameters?: string;
  packagePath?: string;
  entryPoint?: string;
  workspaceScope?: string | null;
}

export interface LocalConfig {
  provider: string;
  endpoint: string;
  model: string;
  contextLimit: number;
  apiKey: string;
  toolProtocol?: CloudToolProtocol;
  /** Optional total provider-request capacity. MAIN reserves one request for
   * the parent before exposing the remainder to bounded child work. */
  maxActiveRequests?: number;
}

export type CloudConfig = CloudProfileConfig;
export type { CloudServerConfig };

export interface AppConfig {
  language: Lang;
  responseLanguagePolicy: ResponseLanguagePolicy;
  theme: ThemeKey;
  themeMode: ThemeMode;
  appIconVariant: "light" | "dark";
  workflowMode: "chat" | "edit" | "plan";
  promptLanguageStrategy: PromptLanguageStrategy;
  toolPermissionPolicy: ToolPermissionPolicy;
  mcpRouting: McpRoutingConfig;
  instructionsEnabled: boolean;
  hooksEnabled: boolean;
  activeProfile: "local" | "cloud";
  chatFontSize: number;
  sessionRecordingEnabled: boolean;
  debugRecordFullTurnProcess: boolean;
  reasoningDisplay: ReasoningDisplayMode;
  eventStreamMode: EventStreamMode;
  toolFeedbackFormat: ToolFeedbackFormat;
  local: LocalConfig;
  cloud: CloudConfig;
  cloudServers: CloudServerConfig[];
  activeCloudServerId: string;
  cloudExperimentalLoginEnabled: boolean;
  imAdapters: ImAdaptersConfig;
  workspace: string;
}

export interface QueuedUserMessageInput {
  text: string;
  images?: string[];
  contextMentions?: string[];
  attachedFiles?: AttachedFile[];
}
