// @ts-nocheck
import React, { useEffect, useRef, useState } from "react";
import { IconBook, IconClose, IconPlus, IconTrash, IconShield, IconFileText, IconEdit, IconPackage } from "./Icons";
import MarkdownRenderer from "./MarkdownRenderer";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import { allowImplicitFromConfig, parseSkillDocument } from "../lib/agentSkills";
import { normalizeExternalSkillSelections, resolveExternalSkillMode } from "../lib/externalSkillSelections";
import { isExternalSkillSourceEnabled, normalizeExternalSkillSources } from "../lib/externalSkillSources";
import { isSafeProtocolPackagePath } from "../lib/protocolPackages";
import { discoverPersonalAgentSkills, extractGlobalSkillPackage, fetchAndInstallGithubSkillPackage, loadGlobalSkillPackageCatalog } from "../lib/ipc";
import type { Skill } from "../lib/appTypes";
import ToggleSwitch from "./ToggleSwitch";
import { checkGithubSkillUpdate } from "../lib/githubSkillUpdates";

const SKILL_SOURCE_KEYS = ["codex", "claude", "gemini", "custom"] as const;

function cleanupProtocolPackage(localPath: string | null, workspace: string | null) {
  if (!localPath) return;
  if (useAppStore.getState().skills.some((skill) => skill.type === "package" &&
    !skill.packageStorage && skill.packagePath === localPath && skill.workspaceScope === workspace)) return;
  void invoke("delete_protocol_package", {
    localPath,
    workspace,
  }).catch((error) => {
    console.error("Pending protocol package cleanup failed:", error);
  });
}

interface PackageSkillPreview {
  name: string;
  description: string;
  unavailable?: boolean;
}

async function readPackagePreviews(
  packagePath: string,
  entryPoints: string[],
  workspace: string,
  fallbackName: string,
  storage?: Skill["packageStorage"],
): Promise<PackageSkillPreview[]> {
  const batch = storage ? await loadGlobalSkillPackageCatalog(storage.packageId).catch(() => null) : null;
  const documents = new Map(batch?.meta.packageId === storage?.packageId
    ? batch?.documents.map((document) => [document.relativePath, document.content]) : []);
  return Promise.all(entryPoints.map(async (entry) => {
    const fallback = entry.replace(/\\/g, "/").split("/").slice(-2, -1)[0] || fallbackName;
    try {
      if (!storage && !isSafeProtocolPackagePath(packagePath, entry)) throw new Error("Invalid Skill entry path");
      const content = storage
        ? documents.get(entry)
        : await invoke<string>("read_file", { path: `${packagePath}/${entry}`, workspace });
      if (typeof content !== "string") throw new Error("Skill document unavailable");
      const parsed = parseSkillDocument(content, fallback, "");
      return { name: parsed.name, description: parsed.description, unavailable: !content.trim() || parsed.warnings.length > 0 };
    } catch {
      return { name: fallback, description: "", unavailable: true };
    }
  }));
}

const SKILLS_COPY = {
  zh: {
    activeDesc: "启用后，下一轮会先向 Agent 展示技能名称和描述；匹配后再加载完整内容。",
    addSkill: "添加技能",
    builtIn: "内置",
    package: "技能包",
    prompt: "自定义规则",
    installedAt: "安装位置：",
    globalScope: "全局 · 所有项目",
    globalLocation: "全局技能库（只读）",
    projectScope: "项目：",
    unknownScope: "旧安装 · 需重新导入",
    globalImport: "全局安装，一次导入后可在所有项目中使用。",
    editSkill: "编辑技能",
    deleteSkill: "删除技能",
    createSkill: "创建新技能",
    skillType: "技能类型",
    instructionDesc: "Agent Skill 会按需加载完整说明；也可在消息中使用 $技能名 或 @技能名 显式启用。",
    packageDesc: "从 GitHub 或 ZIP 导入单个技能或整套技能，MAIN 会保留全部支持文件，并在任务中按需加载各个 SKILL.md。",
    skillName: "技能名称",
    uploadProtocolPackage: "安装技能包",
    zipArchives: "ZIP 压缩包",
    extracting: "解压中...",
    uploadZip: "上传 ZIP",
    uploadFailed: "上传失败",
    packageUploadHint: "支持含 SKILL.md 的单技能 ZIP 和完整技能仓库 ZIP；会保留 references、scripts 等支持文件。旧版 program.md 包仍可导入。",
    unityImportHint: "安装后发送 $unity-cli 检查 CLI 与 Editor 连接，并按指引完成首次环境配置。",
    github: "从 GitHub 安装", githubRepo: "GitHub 仓库或 URL", githubBranch: "分支（默认 main）", unityInstall: "安装 Unity 官方 Skills", discovered: "本机发现的技能", discoveryFailed: "无法读取本机技能，请重新打开面板重试。",
    discoveryLoading: "正在扫描本机技能…", discoveryEmpty: "没有发现本机技能。可通过“添加技能”创建规则或导入技能包。", closeDiscovery: "关闭本机技能选择",
    sourceTitle: "Agent 来源", sourceCustom: "其他", sourcesDisabled: "所有来源均已关闭。开启来源后可选择供 MAIN 使用的技能。",
    sourceHint: "这些全局开关仅控制本机 Agent 来源。关闭后从下次执行和 $ 菜单排除；保留已添加设置，重新开启恢复，新技能仍需手动添加。独立导入的技能包由主面板的包启用开关控制。",
    checkUpdates: "检查更新", checkingUpdate: "检查中…", applyUpdate: "更新", cancelUpdate: "取消更新", latestVersion: "已是最新版本。",
    updateCandidate: "可用更新", updateApplied: "已更新；下次启动执行生效，正在运行的任务保留原版本。",
    updateFailed: "检查未完成，请检查网络和仓库分支后重试。", updateSourceFailed: "GitHub 来源无法验证，请在编辑中重新下载绑定。",
    updateSaveFailed: "无法保存更新，请重试。", updateCheckHint: "手动检查会下载并校验仓库快照。",
    updateStale: "此技能包已更改，请重新检查更新。", updateConflict: "该版本已另行安装，请先处理重复的技能包再检查。",
    githubBindingHint: "来源仅在成功下载并保存后绑定；只修改输入不会改变已安装来源。",
    updateNextRun: "应用后供下次执行使用，当前任务保留原版本。",
    externalHint: "选择供 MAIN 使用的技能，不启动来源 Agent。下次启动执行生效，不影响正在运行的任务。",
    addExternal: "添加到 MAIN", externalScope: "作用范围", externalMode: "使用方式", externalProject: "当前项目", externalGlobal: "全局 · 所有项目",
    externalUnadded: "未添加", externalAuto: "自动匹配", externalManual: "仅手动调用", externalDisabled: "已停用", externalStatus: "MAIN 当前状态：",
    externalScopeHint: "项目设置优先于全局；切换范围可分别设置。", externalSourceManual: "来源规则要求仅手动调用。",
    foundSkills: (count: number) => `发现 ${count} 个技能`,
    containsSkills: (count: number) => `包含 ${count} 个技能`,
    previewUnavailable: "部分技能说明无法完整解析或读取；请检查 SKILL.md 格式和文件访问权限后重试导入。",
    importRetry: "请确认 ZIP 包含 SKILL.md，再重试导入。",
    close: "关闭",
    description: "描述",
    modelDiscoverable: "允许模型自动匹配",
    modelDiscoverableDesc: "关闭后仅能在消息中通过 $技能名或 @技能名显式启用；“自动匹配”表示成为候选，不保证每次调用。",
    manualOnly: "仅手动",
    descPlaceholderRule: "简要描述这条规则",
    systemPromptContent: "SKILL.md 内容",
    edit: "编辑",
    preview: "预览",
    contentPlaceholderInstruction: "输入给模型的规则和说明（支持 Markdown）...",
    nothingToPreview: "暂无可预览内容",
    cancel: "取消",
    updateSkill: "更新技能",
    saveSkill: "保存技能",
    done: "完成",
  },
  en: {
    activeDesc: "On the next Turn, MAIN first shows the Agent each active Skill's name and description, then loads full instructions only when selected.",
    addSkill: "Add Skill",
    builtIn: "Built-in",
    package: "Skill Package",
    prompt: "Custom Skill",
    installedAt: "Installed at:",
    globalScope: "Global · All projects",
    globalLocation: "Global Skill library (read-only)",
    projectScope: "Project:",
    unknownScope: "Legacy installation · Reimport required",
    globalImport: "Install once and use in every project.",
    editSkill: "Edit Skill",
    deleteSkill: "Delete Skill",
    createSkill: "Create New Skill",
    skillType: "Skill Type",
    instructionDesc: "Agent Skills load their full instructions on demand. Use $skill-name or @skill-name in a message for deterministic activation.",
    packageDesc: "Import one Skill or a collection from GitHub or ZIP. MAIN keeps all supporting files and loads each SKILL.md on demand.",
    skillName: "Skill Name",
    uploadProtocolPackage: "Install Skill Package",
    zipArchives: "ZIP Archives",
    extracting: "Extracting...",
    uploadZip: "Upload ZIP",
    uploadFailed: "Upload failed",
    packageUploadHint: "Supports single-Skill ZIPs and complete Skill repository ZIPs containing SKILL.md. All references, scripts, and other files are preserved. Legacy program.md packages are supported.",
    unityImportHint: "After saving, send $unity-cli to check the CLI and Editor connection and follow the first-use setup instructions.",
    github: "Install from GitHub", githubRepo: "GitHub repository or URL", githubBranch: "Branch (default main)", unityInstall: "Install official Unity Skills", discovered: "Skills discovered on this computer", discoveryFailed: "Could not read local Skills. Reopen this panel to retry.",
    discoveryLoading: "Scanning local Skills…", discoveryEmpty: "No local Skills found. Use Add Skill to create rules or import a package.", closeDiscovery: "Close local Skill selection",
    sourceTitle: "Agent sources", sourceCustom: "Other", sourcesDisabled: "All sources are off. Enable a source to choose Skills for MAIN.",
    sourceHint: "These global switches control only local Agent sources. Disabled sources are excluded from the next execution and $ menu. Existing selections return when re-enabled; new Skills still need Add to MAIN. Imported Skill packages have separate enable switches in the main panel.",
    checkUpdates: "Check for updates", checkingUpdate: "Checking…", applyUpdate: "Update", cancelUpdate: "Cancel update", latestVersion: "Already up to date.",
    updateCandidate: "Update available", updateApplied: "Updated for the next execution. Running tasks keep their original version.",
    updateFailed: "Could not check. Verify the network, repository and branch, then retry.", updateSourceFailed: "The GitHub source could not be verified. Download it again through Edit to bind the source.",
    updateSaveFailed: "Could not save the update. Please retry.", updateCheckHint: "A manual check downloads and verifies the repository snapshot.",
    updateStale: "This Skill package changed. Check for updates again.", updateConflict: "This version is already installed separately. Resolve the duplicate before checking again.",
    githubBindingHint: "The source is bound only after a successful download and save. Editing these fields alone does not change the installed source.",
    updateNextRun: "Applying uses the new version for the next execution. Running tasks keep their original version.",
    externalHint: "Choose Skills for MAIN to use. This does not start the source Agent. Changes apply when execution next starts and do not affect a running task.",
    addExternal: "Add to MAIN", externalScope: "Scope", externalMode: "Invocation", externalProject: "Current project", externalGlobal: "Global · All projects",
    externalUnadded: "Not added", externalAuto: "Automatic matching", externalManual: "Manual invocation only", externalDisabled: "Disabled", externalStatus: "Current MAIN status:",
    externalScopeHint: "Project settings override global settings. Switch scope to configure each.", externalSourceManual: "The source Skill requires manual invocation.",
    foundSkills: (count: number) => `Found ${count} Skills`,
    containsSkills: (count: number) => `Contains ${count} Skills`,
    previewUnavailable: "Some Skill documents could not be fully parsed or read. Check the SKILL.md format and file access, then import again.",
    importRetry: "Check that the ZIP contains SKILL.md, then try importing again.",
    close: "Close",
    description: "Description",
    modelDiscoverable: "Allow model matching",
    modelDiscoverableDesc: "When off, this Skill is available only through an explicit $name or @name message mention. Matching makes it a candidate; it does not guarantee invocation.",
    manualOnly: "Manual only",
    descPlaceholderRule: "Brief description of the rule",
    systemPromptContent: "SKILL.md Content",
    edit: "Edit",
    preview: "Preview",
    contentPlaceholderInstruction: "Enter the rules and instructions for the model (Markdown supported)...",
    nothingToPreview: "Nothing to preview",
    cancel: "Cancel",
    updateSkill: "Update Skill",
    saveSkill: "Save Skill",
    done: "Done",
  },
} as const;

function ExternalSkillCard({ skill, workspace, selections, setSelection, copy }) {
  const projectOnly = skill.scope === "workspace";
  // Discovery returns native paths; the selection store uses portable slash
  // paths. Use that same identity at every lookup, including Windows roots.
  const identity = normalizeExternalSkillSelections([{ entryPath: skill.entryPath, workspaceScope: workspace || null, mode: "auto" }])[0];
  const entryPath = identity?.entryPath || skill.entryPath;
  const projectScope = identity?.workspaceScope || null;
  const chooseInitialScope = () => {
    if (!projectScope || (!projectOnly && !selections.some((entry) => entry.entryPath === entryPath && entry.workspaceScope === projectScope) &&
      selections.some((entry) => entry.entryPath === entryPath && entry.workspaceScope === null))) return "global";
    return "project";
  };
  const [scope, setScope] = useState(chooseInitialScope);
  useEffect(() => { setScope(chooseInitialScope()); }, [workspace, skill.entryPath]);
  const workspaceScope = scope === "project" ? projectScope : null;
  const selected = selections.find((entry) => entry.entryPath === entryPath && entry.workspaceScope === workspaceScope);
  const implicitAllowed = allowImplicitFromConfig(skill.openaiYaml);
  const effectiveMode = resolveExternalSkillMode(projectOnly ? selections.filter((entry) => entry.workspaceScope !== null) : selections, skill.entryPath, workspace);
  const modeLabel = (mode) => mode === "disabled" ? copy.externalDisabled : mode === "manual" || (mode === "auto" && !implicitAllowed)
    ? copy.externalManual : mode === "auto" ? copy.externalAuto : copy.externalUnadded;
  const selectMode = (mode) => {
    if (!identity || (projectOnly && !projectScope)) return;
    setSelection({ entryPath, workspaceScope: projectOnly ? projectScope : workspaceScope, mode });
  };
  const controlStyle = { background: "var(--surface-0)", borderColor: "var(--surface-border)", color: "var(--surface-text)" };
  return (
    <li className="rounded-md border p-3 text-[11px]" style={{ borderColor: "var(--surface-border)", background: "var(--surface-0)" }} data-external-skill-path={skill.entryPath}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium" title={skill.entryPath}>{skill.name}</span>
        <span className="rounded border px-1.5 py-0.5 text-[10px]" style={{ borderColor: "var(--surface-border)", color: "var(--surface-text-muted)" }}>
          {{ codex: "Codex", claude: "Claude Code", gemini: "Gemini / Antigravity", custom: "Custom" }[skill.platformSource] || "Custom"}
        </span>
      </div>
      {skill.description && <p className="mt-1" style={{ color: "var(--surface-text-muted)" }}>{skill.description}</p>}
      <p className="mt-1 break-all font-mono text-[10px]" style={{ color: "var(--surface-text-subtle)" }}>{skill.entryPath}</p>
      <p className="mt-2" role="status">{copy.externalStatus} {modeLabel(effectiveMode)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {projectOnly ? <span style={{ color: "var(--surface-text-muted)" }}>{copy.externalProject}</span> : (
          <select aria-label={`${skill.name}: ${copy.externalScope}`} value={scope} onChange={(event) => setScope(event.target.value)} className="rounded-md border px-2 py-1.5 text-[11px] theme-ring" style={controlStyle}>
            {projectScope && <option value="project">{copy.externalProject}</option>}
            <option value="global">{copy.externalGlobal}</option>
          </select>
        )}
        {selected ? (
          <select aria-label={`${skill.name}: ${copy.externalMode}`} value={selected.mode === "auto" && !implicitAllowed ? "manual" : selected.mode} onChange={(event) => selectMode(event.target.value)} className="rounded-md border px-2 py-1.5 text-[11px] theme-ring" style={controlStyle}>
            <option value="auto" disabled={!implicitAllowed}>{copy.externalAuto}</option>
            <option value="manual">{copy.externalManual}</option>
            <option value="disabled">{copy.externalDisabled}</option>
          </select>
        ) : <button onClick={() => selectMode(implicitAllowed ? "auto" : "manual")} disabled={!identity || (projectOnly && !projectScope)} className="rounded-md border px-3 py-1.5 font-bold theme-subtle-bg theme-subtle-border disabled:opacity-50">{copy.addExternal}</button>}
      </div>
      {!implicitAllowed && <p className="mt-2" style={{ color: "var(--surface-text-muted)" }}>{copy.externalSourceManual}</p>}
      {workspace && !projectOnly && <p className="mt-2 text-[10px]" style={{ color: "var(--surface-text-subtle)" }}>{copy.externalScopeHint}</p>}
    </li>
  );
}

export default function SkillsModal({
  isOpen,
  onClose,
  t,
  skills,
  currentWorkspace,
  toggleSkill,
  deleteSkill,
  addSkill,
  updateSkill,
  isAddingSkill,
  setIsAddingSkill,
}) {
  const language = useAppStore((s) => s.config.language) === "en" ? "en" : "zh";
  const externalSkillSelections = useAppStore((s) => s.externalSkillSelections);
  const setExternalSkillSelection = useAppStore((s) => s.setExternalSkillSelection);
  const externalSkillSources = useAppStore((s) => s.externalSkillSources);
  const setExternalSkillSource = useAppStore((s) => s.setExternalSkillSource);
  const applyGithubSkillUpdate = useAppStore((s) => s.applyGithubSkillUpdate);
  const copy = SKILLS_COPY[language];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formType, setFormType] = useState<"instruction" | "package">("instruction");
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formAllowImplicit, setFormAllowImplicit] = useState(true);
  const [contentTab, setContentTab] = useState<"edit" | "preview">("edit");
  const [formPackagePath, setFormPackagePath] = useState<string | null>(null);
  const [formPackageStorage, setFormPackageStorage] = useState<Skill["packageStorage"]>();
  const [formGithubSource, setFormGithubSource] = useState<Skill["githubSource"]>();
  const [formEntryPoint, setFormEntryPoint] = useState<string | null>(null);
  const [formEntryPoints, setFormEntryPoints] = useState<string[]>([]);
  const [formPackageWorkspace, setFormPackageWorkspace] = useState<string | null>(null);
  const [packagePreviews, setPackagePreviews] = useState<PackageSkillPreview[]>([]);
  const [uploadError, setUploadError] = useState("");
  const uploadGeneration = useRef(0);
  const [originalPackagePath, setOriginalPackagePath] = useState<string | null>(null);
  const [originalPackageWorkspace, setOriginalPackageWorkspace] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubBranch, setGithubBranch] = useState("");
  const [discoveredSkills, setDiscoveredSkills] = useState([]);
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  const [isDiscoveryLoading, setIsDiscoveryLoading] = useState(false);
  const [discoveryWorkspace, setDiscoveryWorkspace] = useState<string | null>(null);
  const [discoverySources, setDiscoverySources] = useState(null);
  const [showDiscoveredSkills, setShowDiscoveredSkills] = useState(false);
  const discoveryDialogRef = useRef<HTMLDivElement>(null);
  const discoveryButtonRef = useRef<HTMLButtonElement>(null);
  const discoveryCloseRef = useRef<HTMLButtonElement>(null);
  const [packageUpdates, setPackageUpdates] = useState({});
  const packageUpdateGeneration = useRef(0);
  const packageUpdateRequests = useRef(new Map<string, number>());

  const discardPackageUpdates = () => {
    packageUpdateGeneration.current += 1;
    packageUpdateRequests.current.clear();
    setPackageUpdates({});
  };

  useEffect(() => {
    if (!isOpen) setPackageUpdates({});
    return () => {
      packageUpdateGeneration.current += 1;
      packageUpdateRequests.current.clear();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) setShowDiscoveredSkills(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !showDiscoveredSkills) return;
    discoveryCloseRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setShowDiscoveredSkills(false);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...(discoveryDialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex="0"]') || [])];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !discoveryDialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !discoveryDialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      discoveryButtonRef.current?.focus();
    };
  }, [isOpen, showDiscoveredSkills]);

  useEffect(() => {
    let current = true;
    setDiscoveredSkills([]);
    setDiscoveryWorkspace(null);
    setDiscoverySources(null);
    setDiscoveryFailed(false);
    setIsDiscoveryLoading(isOpen && showDiscoveredSkills);
    const workspace = String(currentWorkspace || "").trim();
    const enabledSources = SKILL_SOURCE_KEYS.filter((source) => isExternalSkillSourceEnabled(externalSkillSources, source));
    if (isOpen && showDiscoveredSkills && enabledSources.length === 0) {
      setDiscoveryWorkspace(workspace);
      setDiscoverySources(externalSkillSources);
      setIsDiscoveryLoading(false);
    } else if (isOpen && showDiscoveredSkills) void discoverPersonalAgentSkills(currentWorkspace || undefined, enabledSources).then((entries) => {
      if (current) {
        setDiscoveredSkills(entries.map((entry) => ({
          ...entry,
          ...parseSkillDocument(entry.content, entry.basePath.split(/[\\/]/).pop() || "Skill", ""),
        })));
        setDiscoveryWorkspace(workspace);
        setDiscoverySources(externalSkillSources);
        setIsDiscoveryLoading(false);
      }
    }).catch(() => { if (current) { setDiscoveryWorkspace(workspace); setDiscoverySources(externalSkillSources); setDiscoveryFailed(true); setIsDiscoveryLoading(false); } });
    return () => { current = false; };
  }, [isOpen, showDiscoveredSkills, currentWorkspace, externalSkillSources]);

  const sourceNames = { codex: "Codex", claude: "Claude Code", gemini: "Gemini / Antigravity", custom: copy.sourceCustom };
  const sourceSettings = normalizeExternalSkillSources(externalSkillSources);
  const discoveryGroups = SKILL_SOURCE_KEYS.filter((source) => sourceSettings[source]).map((source) => ({
    source,
    skills: discoveredSkills.filter((skill) => (SKILL_SOURCE_KEYS.includes(skill.platformSource) ? skill.platformSource : "custom") === source),
  })).filter((group) => group.skills.length > 0);

  const resetForm = () => {
    setFormType("instruction");
    setFormName("");
    setFormDesc("");
    setFormContent("");
    setFormAllowImplicit(true);
    setEditingId(null);
    setContentTab("edit");
    setFormPackagePath(null);
    setFormPackageStorage(undefined);
    setFormGithubSource(undefined);
    setFormEntryPoint(null);
    setFormEntryPoints([]);
    setFormPackageWorkspace(null);
    setPackagePreviews([]);
    setUploadError("");
    setOriginalPackagePath(null);
    setOriginalPackageWorkspace(null);
    setUploadStatus("idle");
    setGithubRepo("");
    setGithubBranch("");
  };

  const isFormEditing = editingId !== null;

  const handleSaveSkill = () => {
    if (!formName.trim()) return;
    if (formType === "package" && (!(formPackageStorage || (formPackagePath && formPackageWorkspace)) || uploadStatus === "uploading")) return;
    if (formType !== "package" && !formContent.trim()) return;
    uploadGeneration.current += 1;
    const patch = {
      name: formName,
      desc: formDesc,
      content: formContent,
      type: formType,
      allowImplicitInvocation: formAllowImplicit,
      toolParameters: undefined,
      githubSource: formType === "package" && formPackageStorage ? formGithubSource : undefined,
      ...(formType === "package"
        ? formPackageStorage ? {
            packageStorage: formPackageStorage,
            packagePath: undefined,
            workspaceScope: undefined,
            entryPoint: formEntryPoint,
            entryPoints: formEntryPoints,
          } : {
            packageStorage: undefined,
            packagePath: formPackagePath,
            entryPoint: formEntryPoint,
            entryPoints: formEntryPoints,
            workspaceScope: formPackageWorkspace,
          }
        : {
            packageStorage: undefined,
            packagePath: undefined,
            entryPoint: undefined,
            entryPoints: undefined,
            workspaceScope: undefined,
          }),
    };
    if (isFormEditing) {
      updateSkill(editingId, patch);
    } else {
      addSkill(patch);
    }
    if (
      originalPackagePath &&
      (formType !== "package" || originalPackagePath !== formPackagePath)
    ) {
      cleanupProtocolPackage(originalPackagePath, originalPackageWorkspace);
    }
    if (
      formType !== "package" &&
      formPackagePath &&
      formPackagePath !== originalPackagePath
    ) {
      cleanupProtocolPackage(formPackagePath, formPackageWorkspace);
    }
    resetForm();
    setIsAddingSkill(false);
  };

  const handleCancel = () => {
    uploadGeneration.current += 1;
    if (formPackagePath && formPackagePath !== originalPackagePath) {
      cleanupProtocolPackage(formPackagePath, formPackageWorkspace);
    }
    resetForm();
    setIsAddingSkill(false);
  };

  const handleEditSkill = (skill: any) => {
    discardPackageUpdate(skill.id);
    const generation = ++uploadGeneration.current;
    setEditingId(skill.id);
    setFormType(skill.type === "package" ? "package" : "instruction");
    setFormName(skill.name);
    setFormDesc(skill.desc);
    setFormContent(skill.content);
    setFormAllowImplicit(skill.allowImplicitInvocation !== false);
    setFormPackagePath(skill.packagePath || null);
    setFormPackageStorage(skill.packageStorage);
    setFormGithubSource(skill.githubSource);
    setGithubRepo(skill.githubSource?.repository || "");
    setGithubBranch(skill.githubSource?.branch || "");
    setFormEntryPoint(skill.entryPoint || null);
    const entries = skill.entryPoints?.length ? skill.entryPoints : skill.entryPoint ? [skill.entryPoint] : [];
    setFormEntryPoints(entries);
    setFormPackageWorkspace(skill.workspaceScope || null);
    setPackagePreviews([]);
    if (skill.type === "package" && (skill.packageStorage || (skill.packagePath && skill.workspaceScope))) {
      void readPackagePreviews(skill.packagePath || "", entries, skill.workspaceScope || "", skill.name, skill.packageStorage).then((previews) => {
        if (generation === uploadGeneration.current) setPackagePreviews(previews);
      });
    }
    setUploadError("");
    setOriginalPackagePath(skill.packagePath || null);
    setOriginalPackageWorkspace(skill.workspaceScope || null);
    setUploadStatus(skill.packageStorage || skill.packagePath ? "done" : "idle");
    setContentTab("edit");
    setIsAddingSkill(true);
  };

  const handleInstallPackage = async (source: "zip" | "github", repository = githubRepo) => {
    const generation = ++uploadGeneration.current;
    setUploadError("");
    setUploadStatus("uploading");
    try {
      let result;
      if (source === "github") {
        result = await fetchAndInstallGithubSkillPackage(repository.trim(), githubBranch.trim() || undefined);
      } else {
        const selected = await open({
          multiple: false,
          filters: [{ name: copy.zipArchives, extensions: ["zip"] }],
        });
        if (generation !== uploadGeneration.current) return;
        if (!selected) {
          setUploadStatus(formPackageStorage || formPackagePath ? "done" : "idle");
          return;
        }
        const zipPath = typeof selected === "string" ? selected : selected[0];
        result = await extractGlobalSkillPackage(zipPath);
      }
      if (generation !== uploadGeneration.current) return;
      const storage = { kind: "global" as const, packageId: result.packageId };
      const entries = [...new Set(result.entryPoints)];
      if (!entries.length || !/^[a-f0-9]{64}$/.test(result.packageId)) {
        throw new Error(copy.importRetry);
      }
      const previews = await readPackagePreviews("", entries, "", result.name, storage);
      if (generation !== uploadGeneration.current) return;
      if (formPackagePath && formPackagePath !== originalPackagePath) {
        cleanupProtocolPackage(formPackagePath, formPackageWorkspace);
      }
      setFormPackagePath(null);
      setFormPackageWorkspace(null);
      setFormPackageStorage(storage);
      setFormGithubSource(source === "github" ? result.githubSource
        : formPackageStorage?.packageId === result.packageId ? formGithubSource : undefined);
      setFormEntryPoint(result.entryPoint);
      setFormEntryPoints(entries);
      setPackagePreviews(previews);
      if (!formName.trim()) setFormName(result.name);
      setUploadStatus("done");
    } catch (error) {
      if (generation !== uploadGeneration.current) return;
      console.error("Package upload failed:", error);
      setUploadError(error instanceof Error ? error.message : String(error));
      setUploadStatus("error");
    }
  };

  const discardPackageUpdate = (id: string) => {
    packageUpdateRequests.current.set(id, (packageUpdateRequests.current.get(id) || 0) + 1);
    setPackageUpdates((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const handleCheckPackageUpdate = async (skill: Skill) => {
    const generation = packageUpdateGeneration.current;
    const request = (packageUpdateRequests.current.get(skill.id) || 0) + 1;
    packageUpdateRequests.current.set(skill.id, request);
    setPackageUpdates((current) => ({ ...current, [skill.id]: { phase: "checking", registration: skill } }));
    const currentRequest = () => generation === packageUpdateGeneration.current && packageUpdateRequests.current.get(skill.id) === request;
    try {
      const candidate = await checkGithubSkillUpdate(skill);
      if (!currentRequest()) return;
      const current = useAppStore.getState().skills.find((entry) => entry.id === skill.id);
      setPackageUpdates((previous) => ({ ...previous, [skill.id]: current !== skill
        ? { phase: "stale", registration: current }
        : { phase: candidate.meta.packageId === skill.packageStorage?.packageId ? "latest" : "available", registration: skill, candidate } }));
    } catch (error) {
      if (!currentRequest()) return;
      console.error("GitHub Skill update check failed:", error);
      const sourceError = /SKILL_GITHUB_SOURCE_(?:REQUIRED|MISMATCH)/.test(error instanceof Error ? error.message : String(error));
      setPackageUpdates((previous) => ({ ...previous, [skill.id]: { phase: "error", registration: skill, sourceError } }));
    }
  };

  const handleApplyPackageUpdate = (skill: Skill, candidate) => {
    try {
      const result = applyGithubSkillUpdate(candidate);
      const registration = useAppStore.getState().skills.find((entry) => entry.id === skill.id);
      setPackageUpdates((current) => ({ ...current, [skill.id]: {
        phase: result.status === "updated" ? "updated" : result.status === "unchanged" ? "latest" : result.status,
        registration,
      } }));
    } catch (error) {
      console.error("GitHub Skill update could not be applied:", error);
      setPackageUpdates((current) => ({ ...current, [skill.id]: { phase: "apply_error", registration: skill, candidate } }));
    }
  };

  const renderPackageUpdate = (skill: Skill) => {
    if (!skill.githubSource || skill.packageStorage?.kind !== "global") return null;
    const saved = packageUpdates[skill.id];
    const state = saved && ["checking", "available", "apply_error"].includes(saved.phase) && saved.registration !== skill
      ? { phase: "stale" } : saved;
    const message = state?.phase === "latest" ? copy.latestVersion : state?.phase === "updated" ? copy.updateApplied
      : state?.phase === "stale" ? copy.updateStale : state?.phase === "conflict" ? copy.updateConflict
        : state?.phase === "apply_error" ? copy.updateSaveFailed
          : state?.phase === "error" ? state.sourceError ? copy.updateSourceFailed : copy.updateFailed : "";
    return <div className="mt-2 space-y-2" data-testid={`skill-package-update-${skill.id}`}>
      <p className="break-all font-mono" style={{ color: "var(--surface-text-muted)" }}>{skill.githubSource.repository} @ {skill.githubSource.branch}</p>
      <p className="text-[10px] leading-relaxed" style={{ color: "var(--surface-text-muted)" }}>{copy.updateCheckHint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-label={`${copy.checkUpdates}: ${skill.name}`} disabled={state?.phase === "checking"}
          onClick={() => void handleCheckPackageUpdate(skill)} className="rounded-md border px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-50"
          style={{ borderColor: "var(--surface-border)", color: "var(--surface-text)" }}>
          {state?.phase === "checking" ? copy.checkingUpdate : copy.checkUpdates}
        </button>
        {["checking", "available", "apply_error"].includes(state?.phase) && <button type="button" aria-label={`${copy.cancelUpdate}: ${skill.name}`} onClick={() => discardPackageUpdate(skill.id)} className="rounded-md border px-2.5 py-1.5 text-[11px]"
          style={{ borderColor: "var(--surface-border)", color: "var(--surface-text-muted)" }}>{copy.cancelUpdate}</button>}
      </div>
      {["available", "apply_error"].includes(state?.phase) && <div className="rounded-md border p-3" style={{ borderColor: "var(--surface-border)", background: "var(--surface-0)", color: "var(--surface-text)" }}>
        <p className="text-[11px] font-semibold">{copy.updateCandidate}</p>
        <p className="mt-1 break-all font-mono text-[11px]">{skill.packageStorage.packageId.slice(0, 12)} → {state.candidate.meta.packageId.slice(0, 12)}</p>
        <p className="mt-1 text-[11px]">{copy.containsSkills(skill.entryPoints?.length || 1)} → {copy.containsSkills(state.candidate.meta.entryPoints.length)}</p>
        <p className="mt-2 text-[10px] leading-relaxed" style={{ color: "var(--surface-text-muted)" }}>{copy.updateNextRun}</p>
        <button type="button" aria-label={`${copy.applyUpdate}: ${skill.name}`} onClick={() => handleApplyPackageUpdate(skill, state.candidate)} className="mt-2 rounded-md px-3 py-1.5 text-[11px] font-bold theme-bg theme-bg-hover">{copy.applyUpdate}</button>
      </div>}
      {message && <p role="status" className="text-[11px] leading-relaxed" style={{ color: "var(--surface-text-muted)" }}>{message}</p>}
    </div>;
  };

  const handleClose = () => {
    discardPackageUpdates();
    onClose();
    handleCancel();
  };

  return isOpen ? (
    <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm">
      <div inert={showDiscoveredSkills || undefined} className="bg-[#09090b] border border-[#27272a] rounded-xl shadow-2xl w-[600px] flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#27272a] flex items-center justify-between bg-[#000000]">
          <h2 className="text-sm font-bold text-white flex items-center gap-2"><IconBook className="w-4 h-4" /> {t.skills}</h2>
          <button aria-label={copy.close} onClick={handleClose} className="text-[#a1a1aa] hover:text-white transition-colors"><IconClose className="w-4 h-4" /></button>
        </div>
        <div className="p-6 flex-1 overflow-y-auto max-h-[60vh] bg-[#09090b]">
          {!isAddingSkill ? (
            <>
              <div className="mb-5 space-y-3">
                <p className="text-xs text-[#a1a1aa]">{copy.activeDesc}</p>
                <div className="flex flex-wrap justify-end gap-2">
                  <button ref={discoveryButtonRef} onClick={() => setShowDiscoveredSkills(true)} className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] font-bold transition-colors" style={{ background: "var(--surface-1)", borderColor: "var(--surface-border)", color: "var(--surface-text)" }}><IconBook className="w-3.5 h-3.5" /> {copy.discovered}</button>
                  <button onClick={() => setIsAddingSkill(true)} className="flex items-center gap-1.5 text-[11px] theme-subtle-bg hover:theme-bg hover:text-white px-3 py-1.5 rounded-md transition-colors font-bold border theme-subtle-border hover:border-transparent"><IconPlus className="w-3.5 h-3.5" /> {copy.addSkill}</button>
                </div>
              </div>
              <div className="space-y-3">
                {skills.map(skill => (
                  <div key={skill.id} className={`group flex items-start gap-3 p-4 rounded-lg border transition-colors shadow-sm ${skill.active ? 'theme-subtle-bg theme-border' : 'bg-[#000000] border-[#27272a] hover:border-[#3f3f46]'}`}>
                    <ToggleSwitch checked={skill.active} onCheckedChange={() => toggleSkill(skill.id)} aria-label={`${skill.name}: ${language === "en" ? "Enabled" : "启用"}`} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[13px] font-bold truncate ${skill.active ? 'text-white' : 'text-[#e4e4e7]'}`}>{skill.name}</span>
                        {skill.isBuiltIn && <IconShield className="w-3 h-3 text-[#71717a] shrink-0" title={copy.builtIn} />}
                        {skill.allowImplicitInvocation === false && (
                          <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-[#18181b] text-[#a1a1aa] border border-[#3f3f46] rounded">{copy.manualOnly}</span>
                        )}
                        {skill.type === "package" ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-[#18181b] text-[#60a5fa] border border-[#1e3a5f] rounded">
                            <IconPackage className="w-2.5 h-2.5" /> {copy.package}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-[#18181b] text-[#86d9a3] border border-[#1a2e1a] rounded">
                            <IconFileText className="w-2.5 h-2.5" /> {copy.prompt}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[#a1a1aa] mt-1.5 line-clamp-2 leading-relaxed">
                        {skill.desc}
                      </div>
                      {skill.type === "package" && (
                        <div className="text-[10px] mt-1" style={{ color: "var(--surface-text-muted)" }}>
                          <span className="block" title={skill.workspaceScope || undefined}>
                            {skill.packageStorage?.kind === "global"
                              ? copy.globalScope
                              : skill.workspaceScope ? `${copy.projectScope} ${skill.workspaceScope}` : copy.unknownScope}
                          </span>
                          <span className="block mt-1 font-mono break-all">
                            {copy.installedAt} {skill.packageStorage?.kind === "global"
                              ? `${copy.globalLocation} · ${skill.packageStorage.packageId.slice(0, 12)}`
                              : skill.packagePath}
                          </span>
                          <span className="block mt-1">{copy.containsSkills(skill.entryPoints?.length || 1)}</span>
                          {renderPackageUpdate(skill)}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button aria-label={`${copy.editSkill}: ${skill.name}`} onClick={() => handleEditSkill(skill)} className="text-[#a1a1aa] hover:text-[#60a5fa] p-1 opacity-0 group-hover:opacity-100 transition-opacity"><IconEdit className="w-4 h-4" /></button>
                      {!skill.isBuiltIn && (
                        <button aria-label={`${copy.deleteSkill}: ${skill.name}`} onClick={() => deleteSkill(skill.id)} className="text-[#a1a1aa] hover:text-red-400 p-1 opacity-0 group-hover:opacity-100 transition-opacity"><IconTrash className="w-4 h-4" /></button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="space-y-5">
              <h3 className="text-xs font-bold text-[#a1a1aa] uppercase tracking-wider">{isFormEditing ? copy.editSkill : copy.createSkill}</h3>

              {/* Skill Type Selector */}
              <div>
                <label className="block text-xs font-bold text-[#e4e4e7] mb-2">{copy.skillType}</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setFormType("instruction")}
                    aria-pressed={formType === "instruction"}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-bold rounded-md border transition-colors ${formType === "instruction" ? "theme-subtle-bg theme-border" : ""}`}
                    style={formType === "instruction" ? undefined : { background: "var(--surface-0)", borderColor: "var(--surface-border)", color: "var(--surface-text-muted)" }}
                  >
                    <IconFileText className="w-3 h-3" /> {copy.prompt}
                  </button>
                  <button
                    onClick={() => setFormType("package")}
                    aria-pressed={formType === "package"}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-bold rounded-md border transition-colors ${formType === "package" ? "theme-subtle-bg theme-border" : ""}`}
                    style={formType === "package" ? undefined : { background: "var(--surface-0)", borderColor: "var(--surface-border)", color: "var(--surface-text-muted)" }}
                  >
                    <IconPackage className="w-3 h-3" /> {copy.package}
                  </button>
                </div>
                <p className="text-[10px] text-[#71717a] mt-1.5">
                  {formType === "instruction"
                    ? copy.instructionDesc
                    : copy.packageDesc}
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#e4e4e7] mb-2">{copy.skillName}</label>
                <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={formType === "package" ? "e.g. Unity Skills" : "e.g. Code Style Guide"} className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[13px] text-white focus:outline-none theme-ring transition-colors" />
              </div>

              {/* Package Upload — only for package-type */}
              {formType === "package" && (
                <div>
                  <label className="block text-xs font-bold text-[#e4e4e7] mb-2">{copy.uploadProtocolPackage}</label>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleInstallPackage("zip")}
                      disabled={uploadStatus === "uploading"}
                      className="flex items-center gap-2 px-4 py-2 text-[12px] font-bold theme-subtle-bg theme-subtle-border border rounded-md transition-colors disabled:opacity-50"
                    >
                      <IconPackage className="w-3.5 h-3.5" />
                      {uploadStatus === "uploading" ? copy.extracting : copy.uploadZip}
                    </button>
                    {uploadStatus === "done" && (formPackageStorage || formPackagePath) && (
                      <span className="text-[11px] font-mono" style={{ color: "var(--surface-text)" }}>✓ {formPackageStorage ? copy.globalScope : formPackagePath}</span>
                    )}
                    {uploadStatus === "error" && (
                      <span role="alert" className="text-[11px] text-red-400">{copy.uploadFailed}: {uploadError} {copy.importRetry}</span>
                    )}
                  </div>
                  <div className="mt-3 space-y-2">
                    <input disabled={uploadStatus === "uploading"} aria-label={copy.githubRepo} placeholder="owner/repo · https://github.com/owner/repo" value={githubRepo} onChange={(event) => setGithubRepo(event.target.value)} className="w-full rounded-md border px-3 py-2 text-[12px] theme-ring" style={{ background: "var(--surface-0)", borderColor: "var(--surface-border)", color: "var(--surface-text)" }} />
                    <input disabled={uploadStatus === "uploading"} aria-label={copy.githubBranch} placeholder={copy.githubBranch} value={githubBranch} onChange={(event) => setGithubBranch(event.target.value)} className="w-full rounded-md border px-3 py-2 text-[12px] theme-ring" style={{ background: "var(--surface-0)", borderColor: "var(--surface-border)", color: "var(--surface-text)" }} />
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => handleInstallPackage("github")} disabled={uploadStatus === "uploading" || !githubRepo.trim()} className="rounded-md border px-3 py-2 text-[11px] font-bold theme-subtle-bg theme-subtle-border disabled:opacity-50">{copy.github}</button>
                      <button onClick={() => { setGithubRepo("Unity-Technologies/skills"); void handleInstallPackage("github", "Unity-Technologies/skills"); }} disabled={uploadStatus === "uploading"} className="rounded-md border px-3 py-2 text-[11px] font-bold disabled:opacity-50" style={{ borderColor: "var(--surface-border)", color: "var(--surface-text)" }}>{copy.unityInstall}</button>
                    </div>
                    <p className="text-[10px] leading-relaxed" style={{ color: "var(--surface-text-muted)" }}>{copy.githubBindingHint}</p>
                  </div>
                  <p role="status" className="text-[11px] mt-2" style={{ color: "var(--surface-text-muted)" }}>{copy.globalImport}</p>
                  <p className="text-[10px] text-[#71717a] mt-1.5">{copy.packageUploadHint}</p>
                  <p className="text-[11px] text-[#a1a1aa] mt-2 leading-relaxed">{copy.unityImportHint}</p>
                  {formEntryPoints.length > 0 && (
                    <div className="mt-3 rounded-md border p-3" style={{ background: "var(--surface-1, #18181b)", borderColor: "var(--surface-border, #27272a)", color: "var(--surface-text, #e4e4e7)" }}>
                      <p className="text-xs font-bold">{copy.foundSkills(formEntryPoints.length)}</p>
                      <ul className="mt-2 max-h-36 overflow-y-auto space-y-2 text-[11px]">
                        {packagePreviews.map((preview, index) => (
                          <li key={formEntryPoints[index]}>
                            <span className="font-mono font-medium">{preview.name}</span>
                            {preview.description && <span className="block mt-0.5" style={{ color: "var(--surface-text-muted, #a1a1aa)" }}>{preview.description}</span>}
                          </li>
                        ))}
                      </ul>
                      {packagePreviews.some((preview) => preview.unavailable) && <p role="alert" className="mt-2 text-[11px]">{copy.previewUnavailable}</p>}
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-[#e4e4e7] mb-2">{copy.description}</label>
                <input type="text" value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder={copy.descPlaceholderRule} className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[13px] text-white focus:outline-none theme-ring transition-colors" />
              </div>

              <label className="flex items-start gap-3 p-3 rounded-md border border-[#27272a] bg-[#000000] cursor-pointer">
                <ToggleSwitch
                  checked={formAllowImplicit}
                  onCheckedChange={setFormAllowImplicit}
                  aria-label={copy.modelDiscoverable}
                  aria-describedby="skill-implicit-description"
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-xs font-bold text-[#e4e4e7]">{copy.modelDiscoverable}</span>
                  <span id="skill-implicit-description" className="block text-[10px] text-[#71717a] mt-1 leading-relaxed">{copy.modelDiscoverableDesc}</span>
                </span>
              </label>

              {/* Package instructions come from its SKILL.md entries. */}
              {formType === "instruction" && (<div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold text-[#e4e4e7]">
                    {copy.systemPromptContent}
                  </label>
                  <div className="flex rounded-md border border-[#27272a] overflow-hidden">
                    <button
                      onClick={() => setContentTab("edit")}
                      className={`px-3 py-1 text-[11px] font-bold transition-colors ${contentTab === "edit" ? "bg-[#18181b] text-white" : "bg-[#000000] text-[#71717a] hover:text-[#a1a1aa]"}`}
                    >{copy.edit}</button>
                    <button
                      onClick={() => setContentTab("preview")}
                      className={`px-3 py-1 text-[11px] font-bold transition-colors border-l border-[#27272a] ${contentTab === "preview" ? "bg-[#18181b] text-white" : "bg-[#000000] text-[#71717a] hover:text-[#a1a1aa]"}`}
                    >{copy.preview}</button>
                  </div>
                </div>
                {contentTab === "edit" ? (
                  <textarea
                    rows="6"
                    value={formContent}
                    onChange={(e) => setFormContent(e.target.value)}
                    placeholder={copy.contentPlaceholderInstruction}
                    className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[13px] text-white focus:outline-none theme-ring resize-y font-mono transition-colors min-h-[120px]"
                  />
                ) : (
                  <div className="w-full bg-[#000000] border border-[#27272a] rounded-md p-3 min-h-[120px] max-h-[300px] overflow-y-auto">
                    {formContent.trim() ? (
                      <MarkdownRenderer content={formContent} />
                    ) : (
                      <p className="text-[13px] text-[#3f3f46] italic">{copy.nothingToPreview}</p>
                    )}
                  </div>
                )}
              </div>)}

              <div className="flex gap-3 pt-2">
                <button onClick={handleCancel} className="flex-1 py-2 text-[12px] font-medium text-[#a1a1aa] border border-[#27272a] bg-[#000000] rounded-md hover:bg-[#18181b] transition-colors">{copy.cancel}</button>
                <button onClick={handleSaveSkill} disabled={!formName.trim() || (formType === "package" ? !(formPackageStorage || (formPackagePath && formPackageWorkspace)) || uploadStatus === "uploading" : !formContent.trim())} className="flex-1 py-2 text-[12px] theme-bg theme-bg-hover font-bold rounded-md transition-colors disabled:opacity-50">{isFormEditing ? copy.updateSkill : copy.saveSkill}</button>
              </div>
            </div>
          )}
        </div>
        {!isAddingSkill && (<div className="px-6 py-4 border-t border-[#27272a] bg-[#000000] flex justify-end"><button onClick={handleClose} className="px-6 py-1.5 theme-bg theme-bg-hover text-[12px] font-bold rounded-md transition-colors shadow-sm">{copy.done}</button></div>)}
      </div>
      {showDiscoveredSkills && (
        <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div ref={discoveryDialogRef} role="dialog" aria-modal="true" aria-labelledby="discovered-skills-dialog-title" className="flex max-h-[80vh] w-[600px] max-w-full flex-col overflow-hidden rounded-xl border shadow-2xl" style={{ background: "var(--surface-1)", borderColor: "var(--surface-border)", color: "var(--surface-text)" }}>
            <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--surface-border)" }}>
              <h3 id="discovered-skills-dialog-title" className="flex items-center gap-2 text-sm font-bold"><IconBook className="h-4 w-4" />{copy.discovered}</h3>
              <button ref={discoveryCloseRef} aria-label={copy.closeDiscovery} onClick={() => setShowDiscoveredSkills(false)} className="rounded-md p-1 theme-ring" style={{ color: "var(--surface-text-muted)" }}><IconClose className="h-4 w-4" /></button>
            </div>
            <div className="overflow-y-auto p-5">
              <p className="mb-4 text-[11px] leading-relaxed" style={{ color: "var(--surface-text-muted)" }}>{copy.externalHint}</p>
              <fieldset className="mb-4 rounded-lg border p-3" style={{ borderColor: "var(--surface-border)", background: "var(--surface-0)" }}>
                <legend className="px-1 text-xs font-semibold">{copy.sourceTitle}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {SKILL_SOURCE_KEYS.map((source) => <label key={source} className="flex cursor-pointer items-center gap-2 text-[11px]">
                    <ToggleSwitch checked={sourceSettings[source]} onCheckedChange={(checked) => setExternalSkillSource(source, checked)} aria-label={sourceNames[source]} />
                    <span>{sourceNames[source]}</span>
                  </label>)}
                </div>
                <p className="mt-3 text-[10px] leading-relaxed" style={{ color: "var(--surface-text-muted)" }}>{copy.sourceHint}</p>
              </fieldset>
              {!SKILL_SOURCE_KEYS.some((source) => sourceSettings[source]) ? <p role="status" className="py-6 text-center text-xs">{copy.sourcesDisabled}</p>
                : isDiscoveryLoading || discoveryWorkspace !== String(currentWorkspace || "").trim() || discoverySources !== externalSkillSources ? <p role="status" className="py-6 text-center text-xs">{copy.discoveryLoading}</p>
                : discoveryFailed ? <p role="status" className="py-6 text-center text-xs">{copy.discoveryFailed}</p>
                : discoveryGroups.length === 0 ? <p role="status" className="py-6 text-center text-xs">{copy.discoveryEmpty}</p>
                : <div className="space-y-5">
                  {discoveryGroups.map((group) => <section key={group.source} aria-labelledby={`discovered-source-${group.source}`}>
                    <h4 id={`discovered-source-${group.source}`} className="mb-2 flex items-center gap-2 text-xs font-semibold">{sourceNames[group.source]}<span style={{ color: "var(--surface-text-subtle)" }}>{group.skills.length}</span></h4>
                    <ul className="space-y-3">
                      {group.skills.map((skill) => <ExternalSkillCard key={skill.entryPath} skill={skill} workspace={String(currentWorkspace || "").trim()} selections={externalSkillSelections} setSelection={(selection) => {
                        const state = useAppStore.getState();
                        if (String(state.currentWorkspace || "").trim() !== discoveryWorkspace || state.externalSkillSources !== discoverySources ||
                          !isExternalSkillSourceEnabled(state.externalSkillSources, skill.platformSource)) return;
                        setExternalSkillSelection(selection);
                      }} copy={copy} />)}
                    </ul>
                  </section>)}
                </div>}
            </div>
          </div>
        </div>
      )}
    </div>
  ) : null;
}
