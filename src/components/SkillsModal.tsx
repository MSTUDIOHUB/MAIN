// @ts-nocheck
import React, { useRef, useState } from "react";
import { IconBook, IconClose, IconPlus, IconCheck, IconTrash, IconShield, IconZap, IconFileText, IconEdit, IconPackage } from "./Icons";
import MarkdownRenderer from "./MarkdownRenderer";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import { parseSkillDocument } from "../lib/agentSkills";
import { isSafeProtocolPackagePath } from "../lib/protocolPackages";
import { extractGlobalSkillPackage, readGlobalSkillPackageFile } from "../lib/ipc";
import type { Skill } from "../lib/appTypes";
import GeminiExtensionsPanel from "./GeminiExtensionsPanel";

/** Convert skill name to a preview of the tool function name (snake_case). */
function nameToToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

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
  return Promise.all(entryPoints.map(async (entry) => {
    const fallback = entry.replace(/\\/g, "/").split("/").slice(-2, -1)[0] || fallbackName;
    try {
      if (!storage && !isSafeProtocolPackagePath(packagePath, entry)) throw new Error("Invalid Skill entry path");
      const content = storage
        ? await readGlobalSkillPackageFile(storage.packageId, entry)
        : await invoke<string>("read_file", { path: `${packagePath}/${entry}`, workspace });
      const parsed = parseSkillDocument(content, fallback, "");
      return { name: parsed.name, description: parsed.description, unavailable: !content.trim() || parsed.warnings.length > 0 };
    } catch {
      return { name: fallback, description: "", unavailable: true };
    }
  }));
}

const DEFAULT_TOOL_PARAMS = `{
  "type": "object",
  "properties": {
    "input": { "type": "string", "description": "Input for this skill" }
  },
  "required": []
}`;

const SKILLS_COPY = {
  zh: {
    activeDesc: "启用后，下一轮会先向 Agent 展示技能名称和描述；匹配后再加载完整内容。",
    addSkill: "添加技能",
    builtIn: "内置",
    tool: "旧版工具描述",
    package: "协议包",
    prompt: "Agent Skill",
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
    toolDesc: "兼容旧数据：这里的说明会作为 Agent Skill 按需加载，但参数 schema 不会冒充可执行工具。真实能力请绑定内置工具、MCP 或插件。",
    packageDesc: "从 ZIP 导入单个技能或整套技能，MAIN 会保留全部支持文件，并在任务中按需加载各个 SKILL.md。",
    skillName: "技能名称",
    toolFunctionName: "旧版 schema 标识（不会直接执行）：",
    uploadProtocolPackage: "上传协议包",
    zipArchives: "ZIP 压缩包",
    extracting: "解压中...",
    uploadZip: "上传 ZIP",
    uploadFailed: "上传失败",
    packageUploadHint: "支持含 SKILL.md 的单技能 ZIP 和完整技能仓库 ZIP；会保留 references、scripts 等支持文件。旧版 program.md 包仍可导入。",
    unityImportHint: "Unity 官方技能：在 GitHub 仓库选择 Code → Download ZIP，直接导入下载的 ZIP。保存后发送 $unity-cli 检查 CLI 与 Editor 连接，并按指引完成首次环境配置。",
    foundSkills: (count: number) => `发现 ${count} 个技能`,
    containsSkills: (count: number) => `包含 ${count} 个技能`,
    previewUnavailable: "部分技能说明无法完整解析或读取；请检查 SKILL.md 格式和文件访问权限后重试导入。",
    importRetry: "请确认 ZIP 包含 SKILL.md，再重试导入。",
    close: "关闭",
    description: "描述",
    modelDiscoverable: "允许模型自动匹配",
    modelDiscoverableDesc: "关闭后仅能在消息中通过 $技能名或 @技能名显式启用；“自动匹配”表示成为候选，不保证每次调用。",
    manualOnly: "仅手动",
    descPlaceholderTool: "模型应何时、如何使用这个工具",
    descPlaceholderRule: "简要描述这条规则",
    systemPromptContent: "SKILL.md 内容",
    toolExecutionInstructions: "工具说明（高级入口）",
    edit: "编辑",
    preview: "预览",
    contentPlaceholderInstruction: "输入给模型的规则和说明（支持 Markdown）...",
    contentPlaceholderTool: "描述模型何时应该调用这个工具，以及后端 handler/MCP 应如何执行（支持 Markdown）...",
    nothingToPreview: "暂无可预览内容",
    toolParameters: "工具参数",
    toolParametersDesc: "仅保留旧版 schema 以兼容已有配置；MAIN 不会把没有真实执行绑定的 schema 暴露给模型。",
    cancel: "取消",
    updateSkill: "更新技能",
    saveSkill: "保存技能",
    done: "完成",
  },
  en: {
    activeDesc: "On the next Turn, MAIN first shows the Agent each active Skill's name and description, then loads full instructions only when selected.",
    addSkill: "Add Skill",
    builtIn: "Built-in",
    tool: "Legacy Tool Spec",
    package: "Package",
    prompt: "Agent Skill",
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
    toolDesc: "Compatibility mode: these instructions load as an Agent Skill, but an unbound schema is never advertised as an executable tool. Bind real capabilities through built-ins, MCP, or a plugin.",
    packageDesc: "Import one Skill or a collection from ZIP. MAIN keeps all supporting files and loads each SKILL.md on demand.",
    skillName: "Skill Name",
    toolFunctionName: "Legacy schema key (not directly executable):",
    uploadProtocolPackage: "Upload Protocol Package",
    zipArchives: "ZIP Archives",
    extracting: "Extracting...",
    uploadZip: "Upload ZIP",
    uploadFailed: "Upload failed",
    packageUploadHint: "Supports single-Skill ZIPs and complete Skill repository ZIPs containing SKILL.md. All references, scripts, and other files are preserved. Legacy program.md packages are supported.",
    unityImportHint: "Official Unity Skills: choose Code → Download ZIP on GitHub and import the downloaded ZIP directly. After saving, send $unity-cli to check the CLI and Editor connection and follow the first-use setup instructions.",
    foundSkills: (count: number) => `Found ${count} Skills`,
    containsSkills: (count: number) => `Contains ${count} Skills`,
    previewUnavailable: "Some Skill documents could not be fully parsed or read. Check the SKILL.md format and file access, then import again.",
    importRetry: "Check that the ZIP contains SKILL.md, then try importing again.",
    close: "Close",
    description: "Description",
    modelDiscoverable: "Allow model matching",
    modelDiscoverableDesc: "When off, this Skill is available only through an explicit $name or @name message mention. Matching makes it a candidate; it does not guarantee invocation.",
    manualOnly: "Manual only",
    descPlaceholderTool: "When and how the model should use this tool",
    descPlaceholderRule: "Brief description of the rule",
    systemPromptContent: "SKILL.md Content",
    toolExecutionInstructions: "Tool Instructions (Advanced)",
    edit: "Edit",
    preview: "Preview",
    contentPlaceholderInstruction: "Enter the rules and instructions for the model (Markdown supported)...",
    contentPlaceholderTool: "Describe when the model should call this tool and how the backend handler/MCP should execute it (Markdown supported)...",
    nothingToPreview: "Nothing to preview",
    toolParameters: "Tool Parameters",
    toolParametersDesc: "Retained only for legacy configuration compatibility. MAIN never advertises an unbound schema as an executable tool.",
    cancel: "Cancel",
    updateSkill: "Update Skill",
    saveSkill: "Save Skill",
    done: "Done",
  },
} as const;

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
  const copy = SKILLS_COPY[language];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formType, setFormType] = useState<"instruction" | "tool" | "package">("instruction");
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formAllowImplicit, setFormAllowImplicit] = useState(true);
  const [formToolParams, setFormToolParams] = useState(DEFAULT_TOOL_PARAMS);
  const [contentTab, setContentTab] = useState<"edit" | "preview">("edit");
  const [formPackagePath, setFormPackagePath] = useState<string | null>(null);
  const [formPackageStorage, setFormPackageStorage] = useState<Skill["packageStorage"]>();
  const [formEntryPoint, setFormEntryPoint] = useState<string | null>(null);
  const [formEntryPoints, setFormEntryPoints] = useState<string[]>([]);
  const [formPackageWorkspace, setFormPackageWorkspace] = useState<string | null>(null);
  const [packagePreviews, setPackagePreviews] = useState<PackageSkillPreview[]>([]);
  const [uploadError, setUploadError] = useState("");
  const uploadGeneration = useRef(0);
  const [originalPackagePath, setOriginalPackagePath] = useState<string | null>(null);
  const [originalPackageWorkspace, setOriginalPackageWorkspace] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");

  const resetForm = () => {
    setFormType("instruction");
    setFormName("");
    setFormDesc("");
    setFormContent("");
    setFormAllowImplicit(true);
    setFormToolParams(DEFAULT_TOOL_PARAMS);
    setEditingId(null);
    setContentTab("edit");
    setFormPackagePath(null);
    setFormPackageStorage(undefined);
    setFormEntryPoint(null);
    setFormEntryPoints([]);
    setFormPackageWorkspace(null);
    setPackagePreviews([]);
    setUploadError("");
    setOriginalPackagePath(null);
    setOriginalPackageWorkspace(null);
    setUploadStatus("idle");
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
      ...(formType === "tool" ? { toolParameters: formToolParams } : {}),
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
    const generation = ++uploadGeneration.current;
    setEditingId(skill.id);
    setFormType(skill.type || "instruction");
    setFormName(skill.name);
    setFormDesc(skill.desc);
    setFormContent(skill.content);
    setFormAllowImplicit(skill.allowImplicitInvocation !== false);
    setFormToolParams(skill.toolParameters || DEFAULT_TOOL_PARAMS);
    setFormPackagePath(skill.packagePath || null);
    setFormPackageStorage(skill.packageStorage);
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

  const handleUploadPackage = async () => {
    const generation = ++uploadGeneration.current;
    setUploadError("");
    setUploadStatus("uploading");
    try {
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
      const result = await extractGlobalSkillPackage(zipPath);
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

  return isOpen ? (
    <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm">
      <div className="bg-[#09090b] border border-[#27272a] rounded-xl shadow-2xl w-[600px] flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#27272a] flex items-center justify-between bg-[#000000]">
          <h2 className="text-sm font-bold text-white flex items-center gap-2"><IconBook className="w-4 h-4" /> {t.skills}</h2>
          <button aria-label={copy.close} onClick={() => { onClose(); handleCancel(); }} className="text-[#a1a1aa] hover:text-white transition-colors"><IconClose className="w-4 h-4" /></button>
        </div>
        <div className="p-6 flex-1 overflow-y-auto max-h-[60vh] bg-[#09090b]">
          {!isAddingSkill ? (
            <>
              <GeminiExtensionsPanel workspace={currentWorkspace || ""} language={language} />
              <div className="flex justify-between items-center mb-5">
                <p className="text-xs text-[#a1a1aa]">{copy.activeDesc}</p>
                <button onClick={() => setIsAddingSkill(true)} className="flex items-center gap-1.5 text-[11px] theme-subtle-bg hover:theme-bg hover:text-white px-3 py-1.5 rounded-md transition-colors font-bold border theme-subtle-border hover:border-transparent"><IconPlus className="w-3.5 h-3.5" /> {copy.addSkill}</button>
              </div>
              <div className="space-y-3">
                {skills.map(skill => (
                  <div key={skill.id} className={`group flex items-start gap-3 p-4 rounded-lg border transition-colors shadow-sm ${skill.active ? 'theme-subtle-bg theme-border' : 'bg-[#000000] border-[#27272a] hover:border-[#3f3f46]'}`}>
                    <div onClick={() => toggleSkill(skill.id)} className={`mt-0.5 w-4 h-4 rounded flex items-center justify-center shrink-0 border cursor-pointer transition-colors ${skill.active ? 'theme-bg theme-border' : 'bg-[#18181b] border-[#3f3f46]'}`}>
                      {skill.active && <IconCheck className="w-3 h-3 text-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[13px] font-bold truncate ${skill.active ? 'text-white' : 'text-[#e4e4e7]'}`}>{skill.name}</span>
                        {skill.isBuiltIn && <IconShield className="w-3 h-3 text-[#71717a] shrink-0" title={copy.builtIn} />}
                        {skill.allowImplicitInvocation === false && (
                          <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-[#18181b] text-[#a1a1aa] border border-[#3f3f46] rounded">{copy.manualOnly}</span>
                        )}
                        {skill.type === "tool" ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-[#18181b] text-[#f59e0b] border border-[#292524] rounded">
                            <IconZap className="w-2.5 h-2.5" /> {copy.tool}
                          </span>
                        ) : skill.type === "package" ? (
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
                        {skill.type === "tool" && (
                          <span className="text-[#f59e0b] font-mono mr-1.5">schema:{nameToToolName(skill.name)}</span>
                        )}
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
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-bold rounded-md border transition-colors ${formType === "instruction" ? "bg-[#0f2e0f] border-[#22c55e] text-[#86d9a3]" : "bg-[#000000] border-[#27272a] text-[#a1a1aa] hover:border-[#3f3f46]"}`}
                  >
                    <IconFileText className="w-3 h-3" /> {copy.prompt}
                  </button>
                  <button
                    onClick={() => setFormType("tool")}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-bold rounded-md border transition-colors ${formType === "tool" ? "bg-[#2e1f0f] border-[#f59e0b] text-[#fbbf24]" : "bg-[#000000] border-[#27272a] text-[#a1a1aa] hover:border-[#3f3f46]"}`}
                  >
                    <IconZap className="w-3 h-3" /> {copy.tool}
                  </button>
                  <button
                    onClick={() => setFormType("package")}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-bold rounded-md border transition-colors ${formType === "package" ? "bg-[#0f1f2e] border-[#3b82f6] text-[#60a5fa]" : "bg-[#000000] border-[#27272a] text-[#a1a1aa] hover:border-[#3f3f46]"}`}
                  >
                    <IconPackage className="w-3 h-3" /> {copy.package}
                  </button>
                </div>
                <p className="text-[10px] text-[#71717a] mt-1.5">
                  {formType === "instruction"
                    ? copy.instructionDesc
                    : formType === "tool"
                    ? copy.toolDesc
                    : copy.packageDesc}
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#e4e4e7] mb-2">{copy.skillName}</label>
                <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={formType === "tool" ? "e.g. Auto Optimize" : formType === "package" ? "e.g. Auto-Optimize Protocol" : "e.g. Code Style Guide"} className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[13px] text-white focus:outline-none theme-ring transition-colors" />
                {formType === "tool" && formName.trim() && (
                  <p className="text-[10px] text-[#f59e0b] mt-1.5 font-mono">{copy.toolFunctionName} <span className="text-[#fbbf24]">{nameToToolName(formName)}</span></p>
                )}
              </div>

              {/* Package Upload — only for package-type */}
              {formType === "package" && (
                <div>
                  <label className="block text-xs font-bold text-[#e4e4e7] mb-2">{copy.uploadProtocolPackage}</label>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleUploadPackage}
                      disabled={uploadStatus === "uploading"}
                      className="flex items-center gap-2 px-4 py-2 text-[12px] font-bold bg-[#0f1f2e] border border-[#3b82f6] text-[#60a5fa] rounded-md hover:bg-[#1e3a5f] transition-colors disabled:opacity-50"
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
                <input type="text" value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder={formType === "tool" ? copy.descPlaceholderTool : copy.descPlaceholderRule} className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[13px] text-white focus:outline-none theme-ring transition-colors" />
              </div>

              <label className="flex items-start gap-3 p-3 rounded-md border border-[#27272a] bg-[#000000] cursor-pointer">
                <input
                  type="checkbox"
                  checked={formAllowImplicit}
                  onChange={(event) => setFormAllowImplicit(event.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-xs font-bold text-[#e4e4e7]">{copy.modelDiscoverable}</span>
                  <span className="block text-[10px] text-[#71717a] mt-1 leading-relaxed">{copy.modelDiscoverableDesc}</span>
                </span>
              </label>

              {/* Content with Edit / Preview tabs */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold text-[#e4e4e7]">
                    {formType === "instruction" ? copy.systemPromptContent : copy.toolExecutionInstructions}
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
                    placeholder={formType === "instruction" ? copy.contentPlaceholderInstruction : copy.contentPlaceholderTool}
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
              </div>

              {/* Tool Parameters JSON Schema — only for tool-type */}
              {formType === "tool" && (
                <div>
                  <label className="block text-xs font-bold text-[#e4e4e7] mb-2">{copy.toolParameters} <span className="text-[#71717a] font-normal">(OpenAI JSON Schema)</span></label>
                  <p className="text-[10px] text-[#71717a] mb-2">{copy.toolParametersDesc}</p>
                  <textarea rows="7" value={formToolParams} onChange={(e) => setFormToolParams(e.target.value)} className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[12px] text-white focus:outline-none theme-ring resize-none font-mono transition-colors"></textarea>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button onClick={handleCancel} className="flex-1 py-2 text-[12px] font-medium text-[#a1a1aa] border border-[#27272a] bg-[#000000] rounded-md hover:bg-[#18181b] transition-colors">{copy.cancel}</button>
                <button onClick={handleSaveSkill} disabled={!formName.trim() || (formType === "package" ? !(formPackageStorage || (formPackagePath && formPackageWorkspace)) || uploadStatus === "uploading" : !formContent.trim())} className="flex-1 py-2 text-[12px] theme-bg theme-bg-hover font-bold rounded-md transition-colors disabled:opacity-50">{isFormEditing ? copy.updateSkill : copy.saveSkill}</button>
              </div>
            </div>
          )}
        </div>
        {!isAddingSkill && (<div className="px-6 py-4 border-t border-[#27272a] bg-[#000000] flex justify-end"><button onClick={onClose} className="px-6 py-1.5 theme-bg theme-bg-hover text-[12px] font-bold rounded-md transition-colors shadow-sm">{copy.done}</button></div>)}
      </div>
    </div>
  ) : null;
}
