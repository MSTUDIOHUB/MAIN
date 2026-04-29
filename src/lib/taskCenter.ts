import type { ResolvedUserIntent } from "./runIntent";

export type TaskCenterTaskStatus =
  | "inbox"
  | "ready"
  | "running"
  | "needs_review"
  | "blocked"
  | "done"
  | "failed"
  | "canceled";

export type TaskCenterRunStatus =
  | "queued"
  | "running"
  | "needs_review"
  | "done"
  | "failed"
  | "canceled";

export type TaskCenterIntent = Extract<ResolvedUserIntent, "plan" | "execute" | "analyze">;
export type TaskCenterSourceProvider = "local" | "linear" | "github" | "feishu";
export type TaskCenterLogLevel = "info" | "warning" | "error";

export interface TaskCenterSubtask {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "blocked";
  owner?: string;
  updatedAt: number;
}

export interface TaskCenterSourceRef {
  provider: TaskCenterSourceProvider;
  externalId?: string;
  url?: string;
  title?: string;
}

export interface TaskCenterRunLog {
  id: string;
  at: number;
  level: TaskCenterLogLevel;
  message: string;
}

export interface TaskCenterRun {
  id: string;
  taskId: string;
  status: TaskCenterRunStatus;
  intent: TaskCenterIntent;
  attempt: number;
  turnId?: string | null;
  startedAt: number;
  endedAt?: number | null;
  summary?: string;
  error?: string;
  logs: TaskCenterRunLog[];
}

export interface TaskCenterTask {
  id: string;
  title: string;
  prompt: string;
  status: TaskCenterTaskStatus;
  source: TaskCenterSourceRef;
  contextMentions: string[];
  attachedFiles: string[];
  imageCount: number;
  subtasks: TaskCenterSubtask[];
  runIds: string[];
  attempts: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
  lastRunId?: string | null;
  lastError?: string | null;
  workspace?: string | null;
}

export interface TaskCenterSchedulerState {
  autoStart: boolean;
  paused: boolean;
  maxReadOnlyConcurrency: number;
  maxWriteConcurrency: number;
  writeLockTaskId?: string | null;
}

export interface TaskCenterIntegrationConfig {
  enabled: boolean;
  token?: string;
  workspaceId?: string;
  projectId?: string;
  repository?: string;
  defaultImportQuery?: string;
  lastSyncAt?: number | null;
}

export interface TaskCenterIntegrationsState {
  linear: TaskCenterIntegrationConfig;
  github: TaskCenterIntegrationConfig;
  feishu: TaskCenterIntegrationConfig;
}

export interface TaskCenterState {
  tasks: TaskCenterTask[];
  runs: TaskCenterRun[];
  selectedTaskId: string | null;
  activeTaskId: string | null;
  scheduler: TaskCenterSchedulerState;
  integrations: TaskCenterIntegrationsState;
}

export interface CreateTaskCenterTaskInput {
  prompt: string;
  title?: string;
  source?: TaskCenterSourceRef;
  contextMentions?: string[];
  attachedFiles?: string[];
  imageCount?: number;
  workspace?: string | null;
  now?: number;
}

export interface ImportedTaskCenterIssue {
  externalId: string;
  title: string;
  body: string;
  url?: string;
  provider: Exclude<TaskCenterSourceProvider, "local">;
}

export interface TaskSourceAdapter {
  provider: Exclude<TaskCenterSourceProvider, "local">;
  isConfigured: () => boolean;
  importIssues: () => Promise<ImportedTaskCenterIssue[]>;
  pushStatus: (task: TaskCenterTask) => Promise<void>;
  postComment: (task: TaskCenterTask, comment: string) => Promise<void>;
  linkTask: (task: TaskCenterTask) => Promise<TaskCenterSourceRef>;
}

const DEFAULT_SCHEDULER: TaskCenterSchedulerState = {
  autoStart: false,
  paused: false,
  maxReadOnlyConcurrency: 2,
  maxWriteConcurrency: 1,
  writeLockTaskId: null,
};

const DEFAULT_INTEGRATION: TaskCenterIntegrationConfig = {
  enabled: false,
  token: "",
  workspaceId: "",
  projectId: "",
  repository: "",
  defaultImportQuery: "",
  lastSyncAt: null,
};

export function createDefaultTaskCenterState(): TaskCenterState {
  return {
    tasks: [],
    runs: [],
    selectedTaskId: null,
    activeTaskId: null,
    scheduler: { ...DEFAULT_SCHEDULER },
    integrations: {
      linear: { ...DEFAULT_INTEGRATION },
      github: { ...DEFAULT_INTEGRATION },
      feishu: { ...DEFAULT_INTEGRATION },
    },
  };
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeStatus(value: unknown): TaskCenterTaskStatus {
  const status = String(value || "");
  return status === "inbox" ||
    status === "ready" ||
    status === "running" ||
    status === "needs_review" ||
    status === "blocked" ||
    status === "done" ||
    status === "failed" ||
    status === "canceled"
    ? status
    : "inbox";
}

function normalizeRunStatus(value: unknown): TaskCenterRunStatus {
  const status = String(value || "");
  return status === "queued" ||
    status === "running" ||
    status === "needs_review" ||
    status === "done" ||
    status === "failed" ||
    status === "canceled"
    ? status
    : "queued";
}

function normalizeIntent(value: unknown): TaskCenterIntent {
  const intent = String(value || "");
  return intent === "plan" || intent === "execute" || intent === "analyze" ? intent : "execute";
}

function normalizeSourceProvider(value: unknown): TaskCenterSourceProvider {
  const provider = String(value || "");
  return provider === "linear" || provider === "github" || provider === "feishu" || provider === "local"
    ? provider
    : "local";
}

function createId(prefix: string, now = Date.now()): string {
  return `${prefix}-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeTitle(input: string, maxLength = 42): string {
  const cleaned = input
    .replace(/\s+/g, " ")
    .replace(/^[/#>-]+\s*/, "")
    .trim();
  if (!cleaned) return "New task";
  return cleaned.length > maxLength ? `${cleaned.slice(0, Math.max(1, maxLength - 3))}...` : cleaned;
}

export function normalizeTaskCenterState(input: Partial<TaskCenterState> | null | undefined): TaskCenterState {
  const fallback = createDefaultTaskCenterState();
  if (!input || typeof input !== "object") return fallback;

  const tasks = Array.isArray(input.tasks)
    ? input.tasks
        .filter((task): task is TaskCenterTask => !!task && typeof task === "object")
        .map((task) => ({
          ...task,
          id: String(task.id || createId("tc-task")),
          title: String(task.title || summarizeTitle(task.prompt || "")),
          prompt: String(task.prompt || ""),
          status: normalizeStatus(task.status),
          source: {
            provider: normalizeSourceProvider(task.source?.provider),
            externalId: task.source?.externalId,
            url: task.source?.url,
            title: task.source?.title,
          },
          contextMentions: uniqueStrings(task.contextMentions),
          attachedFiles: uniqueStrings(task.attachedFiles),
          imageCount: Math.max(0, Number(task.imageCount || 0)),
          subtasks: Array.isArray(task.subtasks) ? task.subtasks : [],
          runIds: uniqueStrings(task.runIds),
          attempts: Math.max(0, Number(task.attempts || 0)),
          createdAt: Number(task.createdAt || Date.now()),
          updatedAt: Number(task.updatedAt || task.createdAt || Date.now()),
          completedAt: task.completedAt ?? null,
          lastRunId: task.lastRunId ?? null,
          lastError: task.lastError ?? null,
          workspace: task.workspace ?? null,
        }))
    : [];

  const runs = Array.isArray(input.runs)
    ? input.runs
        .filter((run): run is TaskCenterRun => !!run && typeof run === "object")
        .map((run) => ({
          ...run,
          id: String(run.id || createId("tc-run")),
          taskId: String(run.taskId || ""),
          status: normalizeRunStatus(run.status),
          intent: normalizeIntent(run.intent),
          attempt: Math.max(1, Number(run.attempt || 1)),
          turnId: run.turnId ?? null,
          startedAt: Number(run.startedAt || Date.now()),
          endedAt: run.endedAt ?? null,
          logs: Array.isArray(run.logs) ? run.logs : [],
        }))
    : [];

  return {
    tasks,
    runs,
    selectedTaskId:
      input.selectedTaskId && tasks.some((task) => task.id === input.selectedTaskId)
        ? input.selectedTaskId
        : tasks[0]?.id ?? null,
    activeTaskId:
      input.activeTaskId && tasks.some((task) => task.id === input.activeTaskId)
        ? input.activeTaskId
        : null,
    scheduler: {
      ...DEFAULT_SCHEDULER,
      ...(input.scheduler || {}),
      maxReadOnlyConcurrency: Math.max(1, Number(input.scheduler?.maxReadOnlyConcurrency ?? DEFAULT_SCHEDULER.maxReadOnlyConcurrency)),
      maxWriteConcurrency: Math.max(1, Number(input.scheduler?.maxWriteConcurrency ?? DEFAULT_SCHEDULER.maxWriteConcurrency)),
    },
    integrations: {
      linear: { ...DEFAULT_INTEGRATION, ...(input.integrations?.linear || {}) },
      github: { ...DEFAULT_INTEGRATION, ...(input.integrations?.github || {}) },
      feishu: { ...DEFAULT_INTEGRATION, ...(input.integrations?.feishu || {}) },
    },
  };
}

export function createTaskCenterTask(input: CreateTaskCenterTaskInput): TaskCenterTask {
  const now = input.now ?? Date.now();
  const prompt = input.prompt.trim();
  return {
    id: createId("tc-task", now),
    title: input.title?.trim() || summarizeTitle(prompt),
    prompt,
    status: "inbox",
    source: input.source || { provider: "local" },
    contextMentions: uniqueStrings(input.contextMentions),
    attachedFiles: uniqueStrings(input.attachedFiles),
    imageCount: Math.max(0, Number(input.imageCount || 0)),
    subtasks: [],
    runIds: [],
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    lastRunId: null,
    lastError: null,
    workspace: input.workspace ?? null,
  };
}

export function startTaskCenterRun(
  state: TaskCenterState,
  taskId: string,
  intent: TaskCenterIntent,
  now = Date.now(),
): { state: TaskCenterState; run: TaskCenterRun | null } {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || task.status === "running" || task.status === "canceled" || task.status === "done") {
    return { state, run: null };
  }

  const attempt = task.attempts + 1;
  const run: TaskCenterRun = {
    id: createId("tc-run", now),
    taskId,
    status: "running",
    intent,
    attempt,
    turnId: null,
    startedAt: now,
    endedAt: null,
    logs: [
      {
        id: createId("tc-log", now),
        at: now,
        level: "info",
        message: intent === "plan" ? "Planning run started." : "Execution run started.",
      },
    ],
  };

  return {
    run,
    state: {
      ...state,
      selectedTaskId: taskId,
      activeTaskId: taskId,
      tasks: state.tasks.map((item) =>
        item.id === taskId
          ? {
              ...item,
              status: "running",
              attempts: attempt,
              runIds: [...item.runIds, run.id],
              lastRunId: run.id,
              lastError: null,
              updatedAt: now,
            }
          : item,
      ),
      runs: [...state.runs, run],
      scheduler: {
        ...state.scheduler,
        writeLockTaskId: intent === "execute" ? taskId : state.scheduler.writeLockTaskId,
      },
    },
  };
}

export function finishTaskCenterRun(
  state: TaskCenterState,
  taskId: string,
  status: TaskCenterTaskStatus,
  message?: string,
  now = Date.now(),
): TaskCenterState {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return state;
  const runId = task.lastRunId || task.runIds[task.runIds.length - 1] || null;
  const runStatus: TaskCenterRunStatus =
    status === "done" ? "done" :
    status === "needs_review" ? "needs_review" :
    status === "canceled" ? "canceled" :
    status === "failed" || status === "blocked" ? "failed" :
    "running";

  return {
    ...state,
    activeTaskId: status === "running" || status === "needs_review" ? taskId : state.activeTaskId === taskId ? null : state.activeTaskId,
    tasks: state.tasks.map((item) =>
      item.id === taskId
        ? {
            ...item,
            status,
            updatedAt: now,
            completedAt: status === "done" ? now : item.completedAt ?? null,
            lastError: status === "failed" || status === "blocked" ? message || item.lastError || "Task stopped." : item.lastError,
          }
        : item,
    ),
    runs: state.runs.map((run) =>
      run.id === runId
        ? {
            ...run,
            status: runStatus,
            endedAt: runStatus === "running" || runStatus === "needs_review" ? run.endedAt ?? null : now,
            summary: status === "done" ? message || run.summary : run.summary,
            error: status === "failed" || status === "blocked" ? message || run.error : run.error,
            logs: message
              ? [
                  ...run.logs,
                  {
                    id: createId("tc-log", now),
                    at: now,
                    level: status === "failed" || status === "blocked" ? "error" : "info",
                    message,
                  },
                ]
              : run.logs,
          }
        : run,
    ),
    scheduler: {
      ...state.scheduler,
      writeLockTaskId: state.scheduler.writeLockTaskId === taskId && status !== "running" && status !== "needs_review"
        ? null
        : state.scheduler.writeLockTaskId,
    },
  };
}

export function appendTaskCenterRunLog(
  state: TaskCenterState,
  taskId: string,
  message: string,
  level: TaskCenterLogLevel = "info",
  now = Date.now(),
): TaskCenterState {
  const task = state.tasks.find((item) => item.id === taskId);
  const runId = task?.lastRunId || task?.runIds[task.runIds.length - 1];
  if (!runId || !message.trim()) return state;
  return {
    ...state,
    tasks: state.tasks.map((item) => item.id === taskId ? { ...item, updatedAt: now } : item),
    runs: state.runs.map((run) =>
      run.id === runId
        ? {
            ...run,
            logs: [
              ...run.logs,
              {
                id: createId("tc-log", now),
                at: now,
                level,
                message,
              },
            ],
          }
        : run,
    ),
  };
}

export function canStartTaskCenterTask(
  state: TaskCenterState,
  task: TaskCenterTask,
  intent: TaskCenterIntent = "execute",
): boolean {
  if (state.scheduler.paused) return false;
  if (task.status !== "ready" && task.status !== "inbox" && task.status !== "failed" && task.status !== "blocked") return false;
  if (intent !== "execute") return true;
  return !state.scheduler.writeLockTaskId || state.scheduler.writeLockTaskId === task.id;
}

export function pickNextTaskCenterTask(
  state: TaskCenterState,
  intent: TaskCenterIntent = "execute",
  statuses?: TaskCenterTaskStatus[],
): TaskCenterTask | null {
  const allowedStatuses = statuses ? new Set(statuses) : null;
  return state.tasks
    .filter((task) => (!allowedStatuses || allowedStatuses.has(task.status)) && canStartTaskCenterTask(state, task, intent))
    .sort((a, b) => a.createdAt - b.createdAt)[0] || null;
}

function isIntegrationConfigured(config: TaskCenterIntegrationConfig): boolean {
  return config.enabled === true && !!String(config.token || "").trim();
}

function createDisabledAdapter(provider: Exclude<TaskCenterSourceProvider, "local">, config: TaskCenterIntegrationConfig): TaskSourceAdapter {
  return {
    provider,
    isConfigured: () => isIntegrationConfigured(config),
    importIssues: async () => {
      if (!isIntegrationConfigured(config)) return [];
      return [];
    },
    pushStatus: async () => {
      if (!isIntegrationConfigured(config)) return;
    },
    postComment: async () => {
      if (!isIntegrationConfigured(config)) return;
    },
    linkTask: async (task) => ({
      provider,
      externalId: task.source.externalId,
      url: task.source.url,
      title: task.source.title || task.title,
    }),
  };
}

export function createTaskSourceAdapters(integrations: TaskCenterIntegrationsState): TaskSourceAdapter[] {
  return [
    createDisabledAdapter("linear", integrations.linear),
    createDisabledAdapter("github", integrations.github),
    createDisabledAdapter("feishu", integrations.feishu),
  ];
}
