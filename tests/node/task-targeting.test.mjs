import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }

    return localRequire(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildTaskTargetingProfile,
  shouldBlockToolCallForTargeting,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/taskTargeting.ts"));

const designSkill = {
  active: true,
  type: "package",
  name: "awesome-design-md-main",
  packagePath: ".protocols/awesome-design-md-main",
  entryPoint: "design-md/DESIGN.md",
};

test("task targeting blocks UI source writes until DESIGN protocol is read or style is confirmed", () => {
  const profile = buildTaskTargetingProfile({
    userPrompt: "请按照当前 Skill 修改 TopIsland 的 UI 样式。",
    skills: [designSkill],
  });

  assert.equal(profile.requiresDesignProtocol, true);
  assert.equal(profile.designProtocolSatisfied, false);
  const blocked = shouldBlockToolCallForTargeting({
    profile,
    toolName: "replace_in_file",
    args: { path: "src/components/TopIsland.tsx" },
    target: "src/components/TopIsland.tsx",
    language: "zh",
  });

  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, "design_protocol_required");

  const satisfied = buildTaskTargetingProfile({
    userPrompt: "请按照当前 Skill 修改 TopIsland 的 UI 样式。",
    skills: [designSkill],
    observedEvidence: ["path:.protocols/awesome-design-md-main/design-md/DESIGN.md"],
  });
  assert.equal(satisfied.designProtocolSatisfied, true);
  assert.equal(shouldBlockToolCallForTargeting({
    profile: satisfied,
    toolName: "replace_in_file",
    args: { path: "src/components/TopIsland.tsx" },
    target: "src/components/TopIsland.tsx",
    language: "zh",
  }).blocked, false);
});

test("task targeting blocks raw read_file on tabular data but allows windowed raw reads", () => {
  const profile = buildTaskTargetingProfile({
    userPrompt: "分析 orders.csv 里面的下单趋势。",
  });

  assert.equal(profile.facets.includes("tabular_data"), true);
  assert.deepEqual(profile.preferredReadTools.slice(0, 2), ["analyze_tabular_document", "query_tabular_document"]);
  const raw = shouldBlockToolCallForTargeting({
    profile,
    toolName: "read_file",
    args: { path: "orders.csv" },
    target: "orders.csv",
    language: "zh",
  });
  assert.equal(raw.blocked, true);
  assert.equal(raw.reason, "tabular_raw_read");

  const windowed = shouldBlockToolCallForTargeting({
    profile,
    toolName: "read_file",
    args: { path: "orders.csv", start_line: 1, max_lines: 20 },
    target: "orders.csv",
    language: "zh",
  });
  assert.equal(windowed.blocked, false);
});

test("task targeting treats imported trend chart requests as tabular work", () => {
  const profile = buildTaskTargetingProfile({
    userPrompt: "导入数据后看不到趋势图、环比和图表分析结果。",
  });

  assert.equal(profile.facets.includes("tabular_data"), true);
  assert.deepEqual(profile.preferredReadTools.slice(0, 2), ["analyze_tabular_document", "query_tabular_document"]);
});

test("task targeting allows full raw CSV reads after structured tabular evidence", () => {
  const profile = buildTaskTargetingProfile({
    userPrompt: "分析 orders.csv 里面的下单趋势。",
    observedEvidence: ["tool:analyze_tabular_document:orders.csv"],
  });

  const raw = shouldBlockToolCallForTargeting({
    profile,
    toolName: "read_file",
    args: { path: "orders.csv" },
    target: "orders.csv",
    language: "zh",
  });

  assert.equal(profile.tabularAnalysisSatisfied, true);
  assert.equal(raw.blocked, false);
});

test("task targeting prefers scoped discovery and blocks broad root skeleton when paths or symbols exist", () => {
  const profile = buildTaskTargetingProfile({
    userPrompt: "修复 useTrendData 在 src/hooks/useTrendData.ts 里的回退逻辑。",
  });

  assert.equal(profile.allowRootSkeleton, false);
  assert.ok(profile.explicitPaths.includes("src/hooks/useTrendData.ts"));
  assert.ok(profile.symbols.includes("useTrendData"));
  const blocked = shouldBlockToolCallForTargeting({
    profile,
    toolName: "get_project_skeleton",
    args: { depth: 4 },
    language: "zh",
  });

  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, "root_skeleton_not_scoped");
});

test("task targeting allows one shallow root skeleton only when there are no scoped cues", () => {
  const profile = buildTaskTargetingProfile({
    userPrompt: "先了解一下这个项目的大致结构。",
  });

  assert.equal(profile.allowRootSkeleton, true);
  assert.equal(shouldBlockToolCallForTargeting({
    profile,
    toolName: "get_project_skeleton",
    args: { depth: 2 },
    language: "zh",
  }).blocked, false);
  assert.equal(shouldBlockToolCallForTargeting({
    profile,
    toolName: "get_project_skeleton",
    args: { depth: 4 },
    language: "zh",
  }).reason, "root_skeleton_too_deep");

  const afterRead = buildTaskTargetingProfile({
    userPrompt: "先了解一下这个项目的大致结构。",
    observedEvidence: ["tool:get_project_skeleton"],
  });
  assert.equal(shouldBlockToolCallForTargeting({
    profile: afterRead,
    toolName: "get_project_skeleton",
    args: { depth: 2 },
    language: "zh",
  }).reason, "root_skeleton_already_read");
});
