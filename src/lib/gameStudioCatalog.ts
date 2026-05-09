export const NEXUS_MODE_KEYS = [
  "nexus_general",
  "nexus_create",
  "nexus_build",
  "nexus_research",
  "nexus_game_studio",
] as const;

export type NexusModeKey = (typeof NEXUS_MODE_KEYS)[number];

export const STUDIO_ENGINE_KEYS = ["unity", "godot", "unreal"] as const;

export type StudioEngineKey = (typeof STUDIO_ENGINE_KEYS)[number];

export const STUDIO_AGENT_KEYS = [
  "studio_auto",
  "creative-director",
  "technical-director",
  "producer",
  "game-designer",
  "lead-programmer",
  "art-director",
  "audio-director",
  "narrative-director",
  "qa-lead",
  "release-manager",
  "localization-lead",
  "gameplay-programmer",
  "engine-programmer",
  "ai-programmer",
  "network-programmer",
  "tools-programmer",
  "ui-programmer",
  "systems-designer",
  "level-designer",
  "economy-designer",
  "technical-artist",
  "sound-designer",
  "writer",
  "world-builder",
  "ux-designer",
  "prototyper",
  "performance-analyst",
  "devops-engineer",
  "analytics-engineer",
  "security-engineer",
  "qa-tester",
  "accessibility-specialist",
  "live-ops-designer",
  "community-manager",
  "godot-specialist",
  "godot-gdscript-specialist",
  "godot-shader-specialist",
  "godot-gdextension-specialist",
  "godot-csharp-specialist",
  "unity-specialist",
  "unity-dots-specialist",
  "unity-shader-specialist",
  "unity-addressables-specialist",
  "unity-ui-specialist",
  "unreal-specialist",
  "ue-gas-specialist",
  "ue-blueprint-specialist",
  "ue-replication-specialist",
  "ue-umg-specialist",
] as const;

export type StudioAgentKey = (typeof STUDIO_AGENT_KEYS)[number];
export type NonAutoStudioAgentKey = Exclude<StudioAgentKey, "studio_auto">;

export const STUDIO_WORKFLOW_COMMAND_SLUGS = [
  "start",
  "help",
  "project-stage-detect",
  "setup-engine",
  "adopt",
  "brainstorm",
  "map-systems",
  "design-system",
  "quick-design",
  "review-all-gdds",
  "propagate-design-change",
  "art-bible",
  "asset-spec",
  "asset-audit",
  "ux-design",
  "ux-review",
  "create-architecture",
  "architecture-decision",
  "architecture-review",
  "create-control-manifest",
  "create-epics",
  "create-stories",
  "dev-story",
  "sprint-plan",
  "sprint-status",
  "story-readiness",
  "story-done",
  "estimate",
  "design-review",
  "code-review",
  "balance-check",
  "content-audit",
  "scope-check",
  "perf-profile",
  "tech-debt",
  "gate-check",
  "consistency-check",
  "qa-plan",
  "smoke-check",
  "soak-test",
  "regression-suite",
  "test-setup",
  "test-helpers",
  "test-evidence-review",
  "test-flakiness",
  "skill-test",
  "skill-improve",
  "milestone-review",
  "retrospective",
  "bug-report",
  "bug-triage",
  "reverse-document",
  "playtest-report",
  "release-checklist",
  "launch-checklist",
  "changelog",
  "patch-notes",
  "hotfix",
  "prototype",
  "onboard",
  "localize",
  "team-combat",
  "team-narrative",
  "team-ui",
  "team-release",
  "team-polish",
  "team-audio",
  "team-level",
  "team-live-ops",
  "team-qa",
  "day-one-patch",
  "security-audit",
] as const;

export type StudioWorkflowCommandSlug = (typeof STUDIO_WORKFLOW_COMMAND_SLUGS)[number];
export type StudioCatalogLanguage = "en" | "zh";

type LocalizedCatalogText = string | Partial<Record<StudioCatalogLanguage, string>>;

export type SlashCommandCatalogItem = {
  id: string;
  label: string;
  kind: "workflow" | "agent";
  canonicalCommand: string;
  aliases: string[];
  group: string;
  description: string;
  engineTags: string[];
};

export type PendingSlashCommand =
  | {
      type: "workflow";
      slug: StudioWorkflowCommandSlug;
      args: string;
      canonicalCommand: string;
    }
  | {
      type: "agent";
      slug: NonAutoStudioAgentKey;
      canonicalCommand: string;
    }
  | {
      type: "auto";
      canonicalCommand: "/auto";
    };

export type GameStudioPackManifest = {
  version: string;
  sourceRepo: string;
  sourceCommitOrTag: string;
  license: string;
  commands: StudioWorkflowCommandSlug[];
  agents: NonAutoStudioAgentKey[];
  rules: string[];
  templates: string[];
  hooks: Array<{
    id: string;
    event: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse";
    command: string;
    compatibility: "native" | "adapted" | "documented";
  }>;
};

export type StudioConfig = {
  engine: string;
  engineLanguage: string;
  engineVersion?: string;
  reviewMode: string;
  activeStudioAgent: StudioAgentKey;
  packVersion: string;
};

export type ParsedSetupEngineArgs = {
  mode: "guided" | "configure" | "refresh" | "upgrade" | "unknown";
  engine: StudioEngineKey | null;
  version?: string;
  raw: string;
};

export const GAME_STUDIO_PACK_VERSION = "ccgs-v1.0.0-beta-main-nexus-v1";
export const GAME_STUDIO_SOURCE_REPO = "https://github.com/Donchitos/Claude-Code-Game-Studios";
export const GAME_STUDIO_SOURCE_TAG = "v1.0.0-beta";

const WORKFLOW_COMMAND_GROUPS: Array<{ group: string; slugs: StudioWorkflowCommandSlug[] }> = [
  { group: "Onboarding", slugs: ["start", "help", "project-stage-detect", "setup-engine", "adopt"] },
  { group: "Game Design", slugs: ["brainstorm", "map-systems", "design-system", "quick-design", "review-all-gdds", "propagate-design-change"] },
  { group: "Art & Assets", slugs: ["art-bible", "asset-spec", "asset-audit"] },
  { group: "UX & Interface", slugs: ["ux-design", "ux-review"] },
  { group: "Architecture", slugs: ["create-architecture", "architecture-decision", "architecture-review", "create-control-manifest"] },
  { group: "Stories & Sprints", slugs: ["create-epics", "create-stories", "dev-story", "sprint-plan", "sprint-status", "story-readiness", "story-done", "estimate"] },
  { group: "Reviews & Analysis", slugs: ["design-review", "code-review", "balance-check", "content-audit", "scope-check", "perf-profile", "tech-debt", "gate-check", "consistency-check", "security-audit"] },
  { group: "QA & Testing", slugs: ["qa-plan", "smoke-check", "soak-test", "regression-suite", "test-setup", "test-helpers", "test-evidence-review", "test-flakiness", "skill-test", "skill-improve"] },
  { group: "Production", slugs: ["milestone-review", "retrospective", "bug-report", "bug-triage", "reverse-document", "playtest-report"] },
  { group: "Release", slugs: ["release-checklist", "launch-checklist", "changelog", "patch-notes", "hotfix", "day-one-patch"] },
  { group: "Creative & Content", slugs: ["prototype", "onboard", "localize"] },
  { group: "Team Orchestration", slugs: ["team-combat", "team-narrative", "team-ui", "team-release", "team-polish", "team-audio", "team-level", "team-live-ops", "team-qa"] },
];

const WORKFLOW_COMMAND_GROUP_LABELS: Record<string, Record<StudioCatalogLanguage, string>> = {
  Onboarding: { en: "Onboarding", zh: "入门引导" },
  "Game Design": { en: "Game Design", zh: "游戏设计" },
  "Art & Assets": { en: "Art & Assets", zh: "美术与资产" },
  "UX & Interface": { en: "UX & Interface", zh: "体验与界面" },
  Architecture: { en: "Architecture", zh: "架构设计" },
  "Stories & Sprints": { en: "Stories & Sprints", zh: "故事与迭代" },
  "Reviews & Analysis": { en: "Reviews & Analysis", zh: "评审与分析" },
  "QA & Testing": { en: "QA & Testing", zh: "质量与测试" },
  Production: { en: "Production", zh: "生产推进" },
  Release: { en: "Release", zh: "发布准备" },
  "Creative & Content": { en: "Creative & Content", zh: "创意与内容" },
  "Team Orchestration": { en: "Team Orchestration", zh: "团队编排" },
};

const AGENT_GROUP_LABELS: Record<string, Record<StudioCatalogLanguage, string>> = {
  Directors: { en: "Directors", zh: "总监层" },
  Leads: { en: "Leads", zh: "负责人" },
  Specialists: { en: "Specialists", zh: "专项专家" },
  "Engine Specialists": { en: "Engine Specialists", zh: "引擎专家" },
};

const WORKFLOW_COMMAND_DESCRIPTION_ZH: Record<StudioWorkflowCommandSlug, string> = {
  start: "首次引导。先了解你当前所处阶段，再把你带到合适的 Studio 工作流，不预设前提。",
  help: "分析当前已完成内容和你的问题，判断下一步该做什么；适合“我该做什么”“卡住了”“不知道下一步”。",
  "project-stage-detect": "自动分析项目现状、识别所处阶段、发现缺口并推荐下一步；适合询问当前开发进度或做全项目审计。",
  "setup-engine": "配置引擎、版本、语言、运行时路径以及基础技术约束，建立后续开发基线。",
  adopt: "将现有项目接入 MAIN GAME STUDIO，梳理当前资产、文档、规则和工作流入口。",
  brainstorm: "把游戏点子扩展为可讨论的方向，梳理核心体验、受众、差异点和设计支柱。",
  "map-systems": "把游戏概念拆解为系统地图，梳理依赖关系、优先级和实现顺序。",
  "design-system": "为指定系统撰写完整 GDD / 系统设计说明，明确目标、规则、反馈与边界。",
  "quick-design": "快速产出轻量设计草案，适合把一个想法先收敛成可讨论的方案。",
  "review-all-gdds": "对全部 GDD 做整体一致性与完整性审查，找出冲突、遗漏和优先修订项。",
  "propagate-design-change": "当某个设计变更后，检查并同步它对其他 GDD、Story、架构与资产规范的影响。",
  "art-bible": "建立美术圣经，统一视觉方向、参考、材质、色彩、镜头感和制作规范。",
  "asset-spec": "为角色、场景、道具或 UI 资产生成可执行的规格说明与交付要求。",
  "asset-audit": "审查现有资产是否符合命名、格式、预算、风格和制作规范。",
  "ux-design": "为菜单、HUD、交互流和关键页面撰写 UX 方案，确保体验路径清晰。",
  "ux-review": "检查 UX 方案与 GDD、可访问性和平台输入方式是否一致。",
  "create-architecture": "产出覆盖主要系统的总体架构文档，明确模块边界、职责和依赖。",
  "architecture-decision": "记录关键技术决策与 ADR，说明为什么这样选以及相应代价。",
  "architecture-review": "审查架构完整性、依赖顺序、引擎适配和潜在技术风险。",
  "create-control-manifest": "从已接受的 ADR 生成统一的程序实现规则清单，便于团队按同一标准开发。",
  "create-epics": "把设计与架构拆成可推进的 Epic，建立模块级实施骨架。",
  "create-stories": "将 Epic 拆解为可实现、可测试、可验收的 Story。",
  "dev-story": "选择一个 Story 进入实现流程，并路由到合适的开发专家继续执行。",
  "sprint-plan": "规划当前迭代，安排优先级、容量、风险和交付目标。",
  "sprint-status": "快速汇总当前 Sprint 进度、阻塞项和剩余工作。",
  "story-readiness": "判断 Story 是否已达到可实现状态，检查验收标准、依赖、设计引用和开放问题。",
  "story-done": "核对实现结果与验收标准，确认是否可以关闭 Story。",
  estimate: "对 Epic、Story 或任务做工作量估算，辅助排期和优先级决策。",
  "design-review": "从设计角度审查方案或产出，检查目标一致性、体验质量和设计风险。",
  "code-review": "从架构、质量、规范和潜在回归角度审查代码实现。",
  "balance-check": "分析数值、成长、资源或战斗平衡，发现异常和失衡点。",
  "content-audit": "审查文案、任务、关卡或内容资产的完整性、一致性与质量。",
  "scope-check": "对照原始范围检测需求膨胀，评估当前内容是否超出既定目标。",
  "perf-profile": "识别 CPU、GPU、内存或加载瓶颈，并给出性能优化方向。",
  "tech-debt": "盘点技术债、风险热点和需要延后治理的问题清单。",
  "gate-check": "作为阶段门检查，判断当前产物是否满足进入下一阶段的条件。",
  "consistency-check": "扫描文档、系统和实现之间的不一致、冲突或引用断裂。",
  "qa-plan": "为 Epic、功能或 Sprint 生成测试计划，覆盖关键路径、边界和风险。",
  "smoke-check": "对核心流程做快速冒烟验证，确认基本功能能跑通。",
  "soak-test": "做长时间稳定性测试，观察内存、性能和累计性问题。",
  "regression-suite": "生成或整理回归测试集，确保旧功能不被新改动破坏。",
  "test-setup": "搭建测试基础设施、目录结构、CI 和执行约定。",
  "test-helpers": "生成测试辅助代码、夹具、模拟器和常用验证工具。",
  "test-evidence-review": "审查测试证据、日志、截图和结果是否足以支撑结论。",
  "test-flakiness": "分析不稳定测试，定位偶发失败根因并提出稳定化方案。",
  "skill-test": "验证某个技能、协议或工作流是否按预期工作。",
  "skill-improve": "根据测试反馈改进技能或协议，使其更稳定、更易用。",
  "milestone-review": "评审里程碑完成度、风险、缺口和是否具备进入下一阶段的条件。",
  retrospective: "做迭代复盘，总结有效做法、问题和后续改进行动。",
  "bug-report": "生成结构化缺陷报告，明确现象、复现步骤、影响和上下文。",
  "bug-triage": "对缺陷做优先级、归类、影响判断和处理建议。",
  "reverse-document": "根据现有实现反向补全文档，说明系统做了什么以及如何工作。",
  "playtest-report": "记录试玩观察、反馈、问题和可行动结论。",
  "release-checklist": "发布前跨团队检查代码、内容、商店、法务和流程准备情况。",
  "launch-checklist": "上线前最后一轮发版检查，确保达到发给玩家的标准。",
  changelog: "从提交、迭代和文档中汇总内部变更记录。",
  "patch-notes": "生成面向玩家的更新说明，强调体验变化和重点修复。",
  hotfix: "为紧急线上问题规划最小修复路径、风险控制和发布节奏。",
  prototype: "快速制作验证性原型，用最短路径验证核心玩法或关键机制。",
  onboard: "设计玩家新手引导、教程流和前期学习体验。",
  localize: "规划或审查本地化内容、术语一致性和多语言交付要求。",
  "team-combat": "编排多位专家协同处理战斗相关复杂特性。",
  "team-narrative": "编排多位专家协同处理叙事、对白与世界观相关特性。",
  "team-ui": "编排多位专家协同处理 UI、HUD 与交互体验相关特性。",
  "team-release": "编排多位专家协同处理发布、验证与上线准备。",
  "team-polish": "编排多位专家协同进行性能、视听和体验打磨。",
  "team-audio": "编排多位专家协同处理音频、音乐与声音实现。",
  "team-level": "编排多位专家协同处理关卡、空间布局和流程体验。",
  "team-live-ops": "编排多位专家协同处理活动、运营和长期维护内容。",
  "team-qa": "编排多位专家协同推进测试、验证和缺陷收敛。",
  "day-one-patch": "规划首日补丁范围、修复优先级和上线节奏。",
  "security-audit": "审查安全风险、权限边界、数据暴露和潜在滥用点。",
};

const AGENT_GROUP_MAP: Record<NonAutoStudioAgentKey, string> = {
  "creative-director": "Directors",
  "technical-director": "Directors",
  "producer": "Directors",
  "game-designer": "Leads",
  "lead-programmer": "Leads",
  "art-director": "Leads",
  "audio-director": "Leads",
  "narrative-director": "Leads",
  "qa-lead": "Leads",
  "release-manager": "Leads",
  "localization-lead": "Leads",
  "gameplay-programmer": "Specialists",
  "engine-programmer": "Specialists",
  "ai-programmer": "Specialists",
  "network-programmer": "Specialists",
  "tools-programmer": "Specialists",
  "ui-programmer": "Specialists",
  "systems-designer": "Specialists",
  "level-designer": "Specialists",
  "economy-designer": "Specialists",
  "technical-artist": "Specialists",
  "sound-designer": "Specialists",
  "writer": "Specialists",
  "world-builder": "Specialists",
  "ux-designer": "Specialists",
  "prototyper": "Specialists",
  "performance-analyst": "Specialists",
  "devops-engineer": "Specialists",
  "analytics-engineer": "Specialists",
  "security-engineer": "Specialists",
  "qa-tester": "Specialists",
  "accessibility-specialist": "Specialists",
  "live-ops-designer": "Specialists",
  "community-manager": "Specialists",
  "godot-specialist": "Engine Specialists",
  "godot-gdscript-specialist": "Engine Specialists",
  "godot-shader-specialist": "Engine Specialists",
  "godot-gdextension-specialist": "Engine Specialists",
  "godot-csharp-specialist": "Engine Specialists",
  "unity-specialist": "Engine Specialists",
  "unity-dots-specialist": "Engine Specialists",
  "unity-shader-specialist": "Engine Specialists",
  "unity-addressables-specialist": "Engine Specialists",
  "unity-ui-specialist": "Engine Specialists",
  "unreal-specialist": "Engine Specialists",
  "ue-gas-specialist": "Engine Specialists",
  "ue-blueprint-specialist": "Engine Specialists",
  "ue-replication-specialist": "Engine Specialists",
  "ue-umg-specialist": "Engine Specialists",
};

const STUDIO_ENGINE_TAGS: Record<string, string[]> = {
  godot: ["godot"],
  unity: ["unity"],
  unreal: ["unreal", "ue5"],
  ue: ["unreal", "ue5"],
};

const COMMAND_ALIAS_MAP: Partial<Record<StudioWorkflowCommandSlug, string[]>> = {
  "setup-engine": ["engine", "setup"],
  "dev-story": ["story"],
  "story-done": ["done"],
  "project-stage-detect": ["stage"],
};

const COMMAND_NAME_LOOKUP = (() => {
  const lookup = new Map<string, StudioWorkflowCommandSlug>();
  for (const slug of STUDIO_WORKFLOW_COMMAND_SLUGS) {
    lookup.set(slug, slug);
    for (const alias of COMMAND_ALIAS_MAP[slug] ?? []) {
      lookup.set(alias, slug);
    }
  }
  return lookup;
})();

function normalizeCatalogLanguage(language?: string | null): StudioCatalogLanguage {
  return language === "en" ? "en" : "zh";
}

function resolveLocalizedText(
  value: LocalizedCatalogText | undefined,
  language: StudioCatalogLanguage,
  fallback: string,
): string {
  if (typeof value === "string") return value;
  if (!value) return fallback;
  return value[language] ?? value.en ?? value.zh ?? fallback;
}

function localizeWorkflowGroup(group: string, language: StudioCatalogLanguage): string {
  return WORKFLOW_COMMAND_GROUP_LABELS[group]?.[language] ?? group;
}

function localizeAgentGroup(group: string, language: StudioCatalogLanguage): string {
  return AGENT_GROUP_LABELS[group]?.[language] ?? group;
}

export function resolveLegacyNexusModeKey(value: string | null | undefined): NexusModeKey {
  switch (value) {
    case "nexus_general":
    case "nexus_create":
    case "nexus_build":
    case "nexus_research":
    case "nexus_game_studio":
      return value;
    case "role_architect":
    case "role_debugger":
      return "nexus_build";
    case "role_uidesigner":
      return "nexus_create";
    case "role_dataanalyst":
      return "nexus_research";
    default:
      return "nexus_general";
  }
}

export function normalizeStudioAgentKey(value: string | null | undefined): StudioAgentKey {
  if (!value) return "studio_auto";
  return (STUDIO_AGENT_KEYS as readonly string[]).includes(value) ? (value as StudioAgentKey) : "studio_auto";
}

export function normalizeStudioEngineKey(value: string | null | undefined): StudioEngineKey | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^unreal\s+engine$/, "unreal")
    .replace(/^ue\s*5?$/, "unreal");
  if (normalized === "unity") return "unity";
  if (normalized === "godot") return "godot";
  if (normalized === "unreal" || normalized === "ue" || normalized === "ue5") return "unreal";
  return null;
}

export function getDefaultStudioAgentForEngine(engine: StudioEngineKey | null | undefined): StudioAgentKey {
  switch (engine) {
    case "unity":
      return "unity-specialist";
    case "godot":
      return "godot-specialist";
    case "unreal":
      return "unreal-specialist";
    default:
      return "studio_auto";
  }
}

export function getDefaultStudioLanguageForEngine(engine: StudioEngineKey | null | undefined): string {
  switch (engine) {
    case "unity":
      return "C#";
    case "godot":
      return "GDScript";
    case "unreal":
      return "C++ / Blueprint";
    default:
      return "unconfigured";
  }
}

export function parseSetupEngineArgs(args: string | null | undefined): ParsedSetupEngineArgs {
  const raw = (args || "").trim();
  if (!raw) return { mode: "guided", engine: null, raw };

  const tokens = raw.split(/\s+/);
  const first = tokens[0]?.toLowerCase() || "";
  if (first === "refresh") return { mode: "refresh", engine: null, raw };
  if (first === "upgrade") return { mode: "upgrade", engine: null, raw };

  const firstTwo = tokens.slice(0, 2).join(" ");
  const engine = normalizeStudioEngineKey(first) || normalizeStudioEngineKey(firstTwo);
  if (!engine) return { mode: "unknown", engine: null, raw };

  const versionTokens = tokens.slice(engine === "unreal" && tokens[1]?.toLowerCase() === "engine" ? 2 : 1);
  const version = versionTokens.join(" ").trim() || undefined;
  return {
    mode: "configure",
    engine,
    ...(version ? { version } : {}),
    raw,
  };
}

export function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => {
      if (part === "qa" || part === "ux" || part === "ui" || part === "ue") return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function getStudioAgentGroup(slug: NonAutoStudioAgentKey): string {
  return AGENT_GROUP_MAP[slug];
}

export function getStudioAgentEngineTags(slug: string): string[] {
  const firstToken = slug.split("-")[0];
  return STUDIO_ENGINE_TAGS[firstToken] ?? [];
}

export function buildWorkflowCommandCatalog(
  descriptions: Partial<Record<StudioWorkflowCommandSlug, LocalizedCatalogText>> = {},
  language: StudioCatalogLanguage = "en",
): SlashCommandCatalogItem[] {
  const resolvedLanguage = normalizeCatalogLanguage(language);
  return WORKFLOW_COMMAND_GROUPS.flatMap(({ group, slugs }) =>
    slugs.map((slug) => {
      const provided = descriptions[slug];
      const localizedDescription =
        typeof provided === "string"
          ? { en: provided, zh: WORKFLOW_COMMAND_DESCRIPTION_ZH[slug] }
          : {
              en: provided?.en ?? "Game Studio workflow command.",
              zh: provided?.zh ?? WORKFLOW_COMMAND_DESCRIPTION_ZH[slug],
            };

      return {
        id: `workflow:${slug}`,
        label: `/${slug}`,
        kind: "workflow" as const,
        canonicalCommand: `/${slug}`,
        aliases: [`/${slug}`, ...(COMMAND_ALIAS_MAP[slug] ?? []).map((alias) => `/${alias}`)],
        group: localizeWorkflowGroup(group, resolvedLanguage),
        description: resolveLocalizedText(
          localizedDescription,
          resolvedLanguage,
          resolvedLanguage === "en" ? "Game Studio workflow command." : WORKFLOW_COMMAND_DESCRIPTION_ZH[slug],
        ),
        engineTags: getStudioAgentEngineTags(slug),
      };
    }),
  );
}

export function buildAgentCatalog(
  descriptions: Partial<Record<NonAutoStudioAgentKey, LocalizedCatalogText>> = {},
  language: StudioCatalogLanguage = "en",
): SlashCommandCatalogItem[] {
  const resolvedLanguage = normalizeCatalogLanguage(language);
  return (STUDIO_AGENT_KEYS.filter((key) => key !== "studio_auto") as NonAutoStudioAgentKey[]).map((slug) => ({
    id: `agent:${slug}`,
    label: humanizeSlug(slug),
    kind: "agent" as const,
    canonicalCommand: `/agent ${slug}`,
    aliases: [slug, `/agent ${slug}`],
    group: localizeAgentGroup(getStudioAgentGroup(slug), resolvedLanguage),
    description: resolveLocalizedText(
      descriptions[slug],
      resolvedLanguage,
      resolvedLanguage === "en" ? "Game Studio specialist profile." : "Game Studio 专家角色说明。",
    ),
    engineTags: getStudioAgentEngineTags(slug),
  }));
}

export function parseGameStudioSlashCommand(input: string): PendingSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const withoutSlash = trimmed.slice(1).trim();
  if (!withoutSlash) return null;

  const [nameRaw, ...rest] = withoutSlash.split(/\s+/);
  const name = nameRaw.toLowerCase();
  const args = rest.join(" ").trim();

  if (name === "auto") {
    return { type: "auto", canonicalCommand: "/auto" };
  }

  if (name === "agent") {
    const slug = normalizeStudioAgentKey(args) as StudioAgentKey;
    if (!args || slug === "studio_auto" || slug !== args) return null;
    return {
      type: "agent",
      slug: slug as NonAutoStudioAgentKey,
      canonicalCommand: `/agent ${slug}`,
    };
  }

  const workflowSlug = COMMAND_NAME_LOOKUP.get(name);
  if (workflowSlug) {
    return {
      type: "workflow",
      slug: workflowSlug,
      args,
      canonicalCommand: args ? `/${workflowSlug} ${args}` : `/${workflowSlug}`,
    };
  }

  return null;
}

export function buildGameStudioUserEnvelope(params: {
  originalText: string;
  activeStudioAgent: StudioAgentKey;
  command: PendingSlashCommand | null;
  commandPath?: string | null;
  agentPath?: string | null;
  studioConfig?: StudioConfig | null;
  responseLanguage?: "zh" | "en";
}): string {
  const responseLanguage = params.responseLanguage === "en" ? "English" : "简体中文";
  const studioConfig = params.studioConfig ?? null;
  const lines = [
    "[GAME_STUDIO_CONTEXT]",
    "mode: nexus_game_studio",
    `activeStudioAgent: ${params.activeStudioAgent}`,
    `responseLanguage: ${responseLanguage}`,
    `engine: ${studioConfig?.engine || "unconfigured"}`,
    `engineLanguage: ${studioConfig?.engineLanguage || "unconfigured"}`,
    `engineVersion: ${studioConfig?.engineVersion || "unconfigured"}`,
    "protocolRoot: .protocols/game-studio",
    "protocolEntry: .protocols/game-studio/SKILL.md",
    params.command ? `slashCommand: ${params.command.canonicalCommand}` : "slashCommand: none",
  ];

  if (params.commandPath) {
    lines.push(`commandPath: ${params.commandPath}`);
  }
  if (params.agentPath) {
    lines.push(`agentPath: ${params.agentPath}`);
  }

  lines.push(
    "instructions: Read the protocol entry first. Then read the referenced command and active agent files before deciding how to respond.",
    studioConfig?.engine === "unity"
      ? "unityExecutionContract: Game Studio owns workflow and expert routing; Unity Editor changes should use Unity MCP when available, prefab/scene/YAML references must be inspected before modification, and C# symbol/reference work should use Roslyn-capable tools when available. If these tools are not exposed, state the capability gap clearly."
      : "",
    `languageInstruction: Reply to the user in ${responseLanguage}. This is a hard output constraint. Only switch language when the user explicitly asks for another reply language in the current turn.`,
    "[/GAME_STUDIO_CONTEXT]",
    "",
    "User request:",
    params.originalText,
  );

  return lines.filter((line) => line !== "").join("\n");
}

export function createDefaultStudioConfig(activeStudioAgent: StudioAgentKey = "studio_auto"): StudioConfig {
  return {
    engine: "unconfigured",
    engineLanguage: "unconfigured",
    reviewMode: "lean",
    activeStudioAgent,
    packVersion: GAME_STUDIO_PACK_VERSION,
  };
}
