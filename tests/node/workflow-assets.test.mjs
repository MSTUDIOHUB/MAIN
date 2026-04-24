import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildPlanCompletionHookResponse,
  parsePlanTasks,
} from "../../scripts/plan_completion_check.mjs";

const workspaceRoot = process.cwd();

test("plan templates and workflow assets exist", async () => {
  const requiredFiles = [
    ".MAIN/hooks.json",
    ".MAIN/templates/intent/intent_analysis.md",
    ".MAIN/templates/plan/requirements.md",
    ".MAIN/templates/plan/design.md",
    ".MAIN/templates/plan/tasks.md",
    ".MAIN/templates/plan/bugfix.md",
  ];

  await Promise.all(
    requiredFiles.map(async (relativePath) => {
      const absolutePath = path.join(workspaceRoot, relativePath);
      const content = await fs.readFile(absolutePath, "utf8");
      assert.ok(content.trim().length > 0, `${relativePath} should not be empty`);
    }),
  );
});

test("plan templates explicitly support data-analysis planning semantics", async () => {
  const requirements = await fs.readFile(path.join(workspaceRoot, ".MAIN/templates/plan/requirements.md"), "utf8");
  const design = await fs.readFile(path.join(workspaceRoot, ".MAIN/templates/plan/design.md"), "utf8");
  const tasks = await fs.readFile(path.join(workspaceRoot, ".MAIN/templates/plan/tasks.md"), "utf8");

  assert.match(requirements, /数据分析/);
  assert.match(requirements, /指标口径/);
  assert.match(design, /分析方法/);
  assert.match(design, /报表结构/);
  assert.match(tasks, /查询/);
  assert.match(tasks, /Markdown 报告/);
});

test("parsePlanTasks extracts checkbox tasks", () => {
  const tasks = parsePlanTasks([
    "# Tasks",
    "",
    "- [x] 第一项",
    "- [ ] 第二项",
  ].join("\n"));

  assert.deepEqual(tasks.map((task) => task.status), ["completed", "pending"]);
  assert.equal(tasks[1].text, "第二项");
});

test("completion hook reminds the model when tasks remain", async () => {
  const response = await buildPlanCompletionHookResponse(
    {
      workflowMode: "plan",
      workspace: workspaceRoot,
      toolName: "write_file",
      toolArgs: { path: "src/App.tsx" },
      isError: false,
    },
    {
      readFile: async () => [
        "# Tasks",
        "",
        "- [x] 已完成任务",
        "- [ ] 剩余任务",
      ].join("\n"),
    },
  );

  assert.ok(response);
  assert.match(response.additionalContext[0], /unfinished checkbox tasks/);
  assert.match(response.additionalContext[1], /剩余任务/);
});

test("completion hook switches to finalization guidance when tasks are done", async () => {
  const response = await buildPlanCompletionHookResponse(
    {
      workflowMode: "plan",
      workspace: workspaceRoot,
      toolName: "write_file",
      toolArgs: { path: "src/App.tsx" },
      isError: false,
    },
    {
      readFile: async () => [
        "# Tasks",
        "",
        "- [x] 第一项",
        "- [x] 第二项",
      ].join("\n"),
    },
  );

  assert.ok(response);
  assert.match(response.additionalContext[0], /all checkbox tasks/);
  assert.match(response.additionalContext[1], /verify the implemented result/);
});
