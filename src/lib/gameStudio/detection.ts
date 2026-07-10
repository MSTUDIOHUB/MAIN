import { normalizeStudioEngineKey, type StudioEngineKey } from "./catalog";

export type GameDevelopmentEngineStatus = "explicit" | "ambiguous" | "none";

export interface GameDevelopmentIntentSignal {
  shouldSuggest: boolean;
  engine: StudioEngineKey | null;
  engineStatus: GameDevelopmentEngineStatus;
  confidence: number;
  reasons: string[];
  projectEvidence: string[];
  semanticEvidence: string[];
}

export interface GameDevelopmentIntentContext {
  workspaceTree?: string | null;
  paths?: string[];
}

const ENGINE_ORDER: StudioEngineKey[] = ["unity", "godot", "unreal"];

const UNITY_PROJECT_PATTERNS: Array<[RegExp, string]> = [
  [/(^|\n)\[D\]\s+Assets(\n|$)/i, "Unity Assets directory"],
  [/(^|\n)\[D\]\s+ProjectSettings(\n|$)/i, "Unity ProjectSettings directory"],
  [/(^|\n)\[D\]\s+Packages(\n|$)/i, "Unity Packages directory"],
  [/\bProjectSettings\/ProjectVersion\.txt\b/i, "Unity ProjectVersion.txt"],
  [/\bPackages\/manifest\.json\b/i, "Unity package manifest"],
  [/\.(unity|prefab|asmdef|asset)\b/i, "Unity asset file"],
  [/\b[A-Za-z0-9_.-]+\.meta\b/i, "Unity .meta file"],
];

const GODOT_PROJECT_PATTERNS: Array<[RegExp, string]> = [
  [/\bproject\.godot\b/i, "Godot project file"],
  [/\.(tscn|tres|gd)\b/i, "Godot scene/script file"],
  [/(^|\n)\[D\]\s+\.godot(\n|$)/i, "Godot metadata directory"],
];

const UNREAL_PROJECT_PATTERNS: Array<[RegExp, string]> = [
  [/\.(uproject|uasset|umap)\b/i, "Unreal project/content file"],
  [/\bConfig\/DefaultEngine\.ini\b/i, "Unreal engine config"],
  [/(^|\n)\[D\]\s+Content(\n|$)/i, "Unreal Content directory"],
];

const ENGINE_SEMANTIC_PATTERNS: Record<StudioEngineKey, Array<[RegExp, string]>> = {
  unity: [
    [/\bunity\b/i, "Unity mentioned"],
    [/\bprefabs?\b/i, "Prefab mentioned"],
    [/\bgame\s*object\b|\bgameobject\b/i, "GameObject mentioned"],
    [/\bmono\s*behaviou?r\b|\bmonobehaviour\b/i, "MonoBehaviour mentioned"],
    [/\bscriptable\s*object\b|\bscriptableobject\b/i, "ScriptableObject mentioned"],
    [/\baddressables?\b/i, "Addressables mentioned"],
    [/\bC#\b.*\b(Unity|MonoBehaviour|GameObject|Prefab)\b/i, "Unity C# context"],
    [/预制体|游戏对象|可寻址资源|MonoBehaviour|Prefab/i, "Unity Chinese term"],
  ],
  godot: [
    [/\bgodot\b/i, "Godot mentioned"],
    [/\bgdscript\b/i, "GDScript mentioned"],
    [/\bnode2d\b|\bnode3d\b/i, "Godot node mentioned"],
    [/Godot|GDScript|节点场景/i, "Godot Chinese term"],
  ],
  unreal: [
    [/\bunreal\b|\bue5\b|\bue\s*5\b/i, "Unreal mentioned"],
    [/\bblueprint\b|\bblueprints\b/i, "Blueprint mentioned"],
    [/\bnanite\b|\blumen\b|\bgas\b/i, "Unreal system mentioned"],
    [/虚幻|蓝图|Unreal|UE5|Gameplay Ability System/i, "Unreal Chinese term"],
  ],
};

const STRONG_GAME_DEVELOPMENT_PATTERNS: Array<[RegExp, string]> = [
  [/游戏开发|游戏项目|游戏工作室|游戏原型|玩法系统|关卡设计|角色控制器|战斗系统|技能系统|存档系统|背包系统|任务系统|数值平衡|美术资源|动画状态机|碰撞体|寻路|敌人 AI/i, "Chinese game-development terminology"],
  [/\bgame\s+dev(elopment)?\b|\bgameplay\b|\blevel\s+design\b|\bcharacter\s+controller\b|\bcombat\s+system\b|\bbattle\s+system\b|\binventory\s+system\b|\bsave\s+system\b|\bquest\s+system\b|\bgame\s+prototype\b/i, "English game-development terminology"],
  [/\bshader(s)?\b|\bparticle\s+system\b|\banimation\s+controller\b|\bnavmesh\b|\bcollider\b|\brigidbody\b/i, "runtime/game-engine implementation term"],
  [/((做|制作|开发|实现|设计|搭建|改|优化|调试).{0,12}游戏)|(游戏.{0,12}(开发|制作|实现|设计|项目|Demo|原型|玩法|关卡|角色|战斗|系统))/i, "game creation intent"],
  [/\b(create|build|implement|prototype|design|debug|tune)\b.{0,32}\b(game|gameplay|level|player|enemy|combat)\b/i, "game creation verb"],
];

const WEAK_GAME_TERMS: RegExp[] = [
  /游戏|玩法|关卡|角色|战斗|敌人|玩家|技能|怪物|场景/i,
  /\bgame\b|\bplayer\b|\benemy\b|\blevel\b|\bcharacter\b|\bcombat\b|\bquest\b|\bscene\b/i,
];

const DEVELOPMENT_VERBS = /开发|制作|实现|设计|搭建|修改|优化|调试|生成|创建|接入|build|create|implement|design|debug|tune|prototype|fix/i;

function collectEvidence(
  source: string,
  patterns: Array<[RegExp, string]>,
): string[] {
  if (!source.trim()) return [];
  return patterns
    .filter(([pattern]) => pattern.test(source))
    .map(([, reason]) => reason);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function collectEngineEvidence(input: string, projectSource: string) {
  const projectEvidence: Partial<Record<StudioEngineKey, string[]>> = {};
  const semanticEvidence: Partial<Record<StudioEngineKey, string[]>> = {};

  const unityProjectEvidence = collectEvidence(projectSource, UNITY_PROJECT_PATTERNS);
  const hasUnitySpecificFile = unityProjectEvidence.some((reason) =>
    reason !== "Unity Assets directory" &&
    reason !== "Unity Packages directory" &&
    reason !== "Unity ProjectSettings directory",
  );
  const hasUnityDirectoryShape =
    unityProjectEvidence.includes("Unity Assets directory") &&
    unityProjectEvidence.includes("Unity ProjectSettings directory");
  projectEvidence.unity = hasUnitySpecificFile || hasUnityDirectoryShape ? unityProjectEvidence : [];
  projectEvidence.godot = collectEvidence(projectSource, GODOT_PROJECT_PATTERNS);
  projectEvidence.unreal = collectEvidence(projectSource, UNREAL_PROJECT_PATTERNS);

  for (const engine of ENGINE_ORDER) {
    semanticEvidence[engine] = collectEvidence(input, ENGINE_SEMANTIC_PATTERNS[engine]);
  }

  const projectEngines = ENGINE_ORDER.filter((engine) => (projectEvidence[engine]?.length ?? 0) > 0);
  const semanticEngines = ENGINE_ORDER.filter((engine) => (semanticEvidence[engine]?.length ?? 0) > 0);
  return { projectEvidence, semanticEvidence, projectEngines, semanticEngines };
}

function hasStrongGameDevelopmentSemantics(input: string): string[] {
  const strong = collectEvidence(input, STRONG_GAME_DEVELOPMENT_PATTERNS);
  if (strong.length > 0) return strong;

  const weakMatches = WEAK_GAME_TERMS.filter((pattern) => pattern.test(input)).length;
  if (weakMatches >= 2 && DEVELOPMENT_VERBS.test(input)) {
    return ["multiple game terms with a development verb"];
  }
  return [];
}

export function detectGameDevelopmentIntent(
  input: string,
  context: GameDevelopmentIntentContext = {},
): GameDevelopmentIntentSignal {
  const normalizedInput = String(input || "");
  const workspaceTree = context.workspaceTree || "";
  const paths = (context.paths || []).join("\n");
  const projectSource = [workspaceTree, paths].filter(Boolean).join("\n");
  const explicitTextEngine = normalizeStudioEngineKey(normalizedInput);
  const {
    projectEvidence,
    semanticEvidence,
    projectEngines,
    semanticEngines,
  } = collectEngineEvidence(normalizedInput, projectSource);
  const strongSemantics = hasStrongGameDevelopmentSemantics(normalizedInput);

  const engineSet = new Set<StudioEngineKey>([
    ...projectEngines,
    ...semanticEngines,
    ...(explicitTextEngine ? [explicitTextEngine] : []),
  ]);
  const engineCandidates = ENGINE_ORDER.filter((engine) => engineSet.has(engine));
  const projectReasons = unique(ENGINE_ORDER.flatMap((engine) => projectEvidence[engine] || []));
  const semanticReasons = unique([
    ...ENGINE_ORDER.flatMap((engine) => semanticEvidence[engine] || []),
    ...strongSemantics,
  ]);

  if (engineCandidates.length > 1) {
    return {
      shouldSuggest: true,
      engine: null,
      engineStatus: "ambiguous",
      confidence: 0.76,
      reasons: [
        "Detected multiple possible game engines; ask the user to choose before configuring Game Studio.",
        ...projectReasons,
        ...semanticReasons,
      ],
      projectEvidence: projectReasons,
      semanticEvidence: semanticReasons,
    };
  }

  if (engineCandidates.length === 1) {
    const engine = engineCandidates[0];
    return {
      shouldSuggest: true,
      engine,
      engineStatus: "explicit",
      confidence: projectEngines.includes(engine) ? 0.92 : 0.86,
      reasons: [
        `Detected ${engine} game-development context.`,
        ...projectReasons,
        ...semanticReasons,
      ],
      projectEvidence: projectReasons,
      semanticEvidence: semanticReasons,
    };
  }

  if (strongSemantics.length > 0) {
    return {
      shouldSuggest: true,
      engine: null,
      engineStatus: "ambiguous",
      confidence: 0.7,
      reasons: [
        "Detected game-development intent, but no specific engine is clear.",
        ...strongSemantics,
      ],
      projectEvidence: projectReasons,
      semanticEvidence: strongSemantics,
    };
  }

  return {
    shouldSuggest: false,
    engine: null,
    engineStatus: "none",
    confidence: 0,
    reasons: [],
    projectEvidence: projectReasons,
    semanticEvidence: semanticReasons,
  };
}
