import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const READ_ONLY_TOOLS = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "read_file",
  "read_pty_buffer",
  "get_project_skeleton",
  "get_file_outline",
]);

function normalizePathLike(input = "") {
  return String(input).replace(/\\/g, "/").toLowerCase();
}

function isPlanArtifactPath(input = "") {
  return normalizePathLike(input).includes(".main/plans/");
}

export function parsePlanTasks(markdown) {
  if (!String(markdown).trim()) return [];

  return String(markdown)
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/))
    .filter(Boolean)
    .map((match, index) => ({
      id: `task-${index + 1}`,
      text: match[2].trim(),
      status: match[1].toLowerCase() === "x" ? "completed" : "pending",
    }));
}

function shouldInspectCompletion(payload) {
  if (payload?.workflowMode !== "plan") return false;

  const toolName = String(payload?.toolName ?? "").trim();
  if (!toolName) return false;

  const toolArgs =
    payload?.toolArgs && typeof payload.toolArgs === "object"
      ? payload.toolArgs
      : {};
  const targetPath =
    typeof toolArgs.path === "string" ? toolArgs.path : "";
  const planArtifactWrite =
    toolName === "write_file" && isPlanArtifactPath(targetPath);
  const tasksFileWrite =
    toolName === "write_file" &&
    normalizePathLike(targetPath).endsWith(".main/plans/tasks.md");
  const executionLike =
    !READ_ONLY_TOOLS.has(toolName) && !planArtifactWrite;

  return tasksFileWrite || executionLike;
}

export async function buildPlanCompletionHookResponse(
  payload,
  {
    readFile = (filePath) => fs.readFile(filePath, "utf8"),
  } = {},
) {
  if (!shouldInspectCompletion(payload)) {
    return null;
  }

  const workspace = String(payload?.workspace || process.cwd()).trim() || process.cwd();
  const tasksPath = path.join(workspace, ".MAIN", "plans", "tasks.md");

  let tasksMarkdown = "";
  try {
    tasksMarkdown = await readFile(tasksPath);
  } catch {
    return null;
  }

  const tasks = parsePlanTasks(tasksMarkdown);
  if (tasks.length === 0) return null;

  const remainingTasks = tasks.filter((task) => task.status !== "completed");
  const completedCount = tasks.length - remainingTasks.length;
  const lastStepFailed = payload?.isError === true;

  if (remainingTasks.length > 0) {
    const nextTask = remainingTasks[0];
    return {
      additionalContext: [
        `Plan completion guard: tasks.md still has ${remainingTasks.length}/${tasks.length} unfinished checkbox tasks.`,
        `Do not declare the work complete yet. Continue from the next unfinished task: ${nextTask.text}`,
        lastStepFailed
          ? "The last tool step failed. Fix or reroute the blocked task before moving on."
          : `Completed so far: ${completedCount}/${tasks.length}. Keep tasks.md synchronized with real execution evidence.`,
      ],
    };
  }

  return {
    additionalContext: [
      "Plan completion guard: all checkbox tasks in tasks.md are complete.",
      "Before ending, verify the implemented result and report completed work, verification, and residual risk in the final reply.",
      `Execution progress summary: ${completedCount}/${tasks.length} tasks complete.`,
    ],
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }
  return chunks.join("");
}

async function main() {
  const raw = await readStdin();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const response = await buildPlanCompletionHookResponse(payload);
  if (response) {
    process.stdout.write(JSON.stringify(response));
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
