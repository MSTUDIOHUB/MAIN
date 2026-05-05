// @ts-nocheck
import React, { useState } from "react";
import { IconBook, IconClose, IconPlus, IconCheck, IconTrash, IconShield, IconZap, IconFileText, IconEdit, IconPackage } from "./Icons";
import MarkdownRenderer from "./MarkdownRenderer";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";

/** Convert skill name to a preview of the tool function name (snake_case). */
function nameToToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
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
    activeDesc: "启用的技能会注入到 Agent 上下文中。",
    addSkill: "添加技能",
    builtIn: "内置",
    tool: "工具",
    package: "协议包",
    prompt: "提示词",
    installedAt: "安装位置：",
    editSkill: "编辑技能",
    createSkill: "创建新技能",
    skillType: "技能类型",
    instructionDesc: "提示词型技能会注入到系统提示词中，指导模型的行为规范。",
    toolDesc: "工具型技能会转换为 function schema，适合高级自定义工具入口；真实外部执行建议做成内置工具或 MCP 工具。",
    packageDesc: "协议包型技能从 ZIP 压缩包导入，包含完整的多文件工作流协议，解压至 .protocols/ 目录后自动注入。",
    skillName: "技能名称",
    toolFunctionName: "工具函数名：",
    uploadProtocolPackage: "上传协议包",
    zipArchives: "ZIP 压缩包",
    extracting: "解压中...",
    uploadZip: "上传 ZIP",
    uploadFailed: "上传失败",
    packageUploadHint: "选择一个 .zip 文件，将自动解压至工作区的 .protocols/ 目录。ZIP 应包含 SKILL.md 或 program.md 作为入口文件。",
    description: "描述",
    descPlaceholderTool: "模型应何时、如何使用这个工具",
    descPlaceholderRule: "简要描述这条规则",
    systemPromptContent: "系统提示词内容",
    toolExecutionInstructions: "工具说明（高级入口）",
    edit: "编辑",
    preview: "预览",
    contentPlaceholderInstruction: "输入给模型的规则和说明（支持 Markdown）...",
    contentPlaceholderTool: "描述模型何时应该调用这个工具，以及后端 handler/MCP 应如何执行（支持 Markdown）...",
    nothingToPreview: "暂无可预览内容",
    toolParameters: "工具参数",
    toolParametersDesc: "定义此工具接受的参数格式，符合 OpenAI function calling 规范。当前 MAIN 只内置 schema 暴露；执行需内置工具、MCP 或自定义 execute_skill 后端。",
    cancel: "取消",
    updateSkill: "更新技能",
    saveSkill: "保存技能",
    done: "完成",
  },
  en: {
    activeDesc: "Active skills will be injected into the Agent's context.",
    addSkill: "Add Skill",
    builtIn: "Built-in",
    tool: "Tool",
    package: "Package",
    prompt: "Prompt",
    installedAt: "Installed at:",
    editSkill: "Edit Skill",
    createSkill: "Create New Skill",
    skillType: "Skill Type",
    instructionDesc: "Prompt skills are injected into the system prompt to guide model behavior.",
    toolDesc: "Tool skills become function schemas for advanced custom tools; real external execution should usually live in built-in tools or MCP tools.",
    packageDesc: "Package skills are imported from ZIP archives, include multi-file workflow protocols, and are extracted into .protocols/ before injection.",
    skillName: "Skill Name",
    toolFunctionName: "Tool function name:",
    uploadProtocolPackage: "Upload Protocol Package",
    zipArchives: "ZIP Archives",
    extracting: "Extracting...",
    uploadZip: "Upload ZIP",
    uploadFailed: "Upload failed",
    packageUploadHint: "Choose a .zip file. It will be extracted into the workspace .protocols/ folder. The ZIP should include SKILL.md or program.md as the entry file.",
    description: "Description",
    descPlaceholderTool: "When and how the model should use this tool",
    descPlaceholderRule: "Brief description of the rule",
    systemPromptContent: "System Prompt Content",
    toolExecutionInstructions: "Tool Instructions (Advanced)",
    edit: "Edit",
    preview: "Preview",
    contentPlaceholderInstruction: "Enter the rules and instructions for the model (Markdown supported)...",
    contentPlaceholderTool: "Describe when the model should call this tool and how the backend handler/MCP should execute it (Markdown supported)...",
    nothingToPreview: "Nothing to preview",
    toolParameters: "Tool Parameters",
    toolParametersDesc: "Define the parameter schema using the OpenAI function calling format. MAIN currently exposes the schema only; execution needs a built-in tool, MCP tool, or custom execute_skill backend.",
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
  const [formToolParams, setFormToolParams] = useState(DEFAULT_TOOL_PARAMS);
  const [contentTab, setContentTab] = useState<"edit" | "preview">("edit");
  const [formPackagePath, setFormPackagePath] = useState<string | null>(null);
  const [formEntryPoint, setFormEntryPoint] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");

  const resetForm = () => {
    setFormType("instruction");
    setFormName("");
    setFormDesc("");
    setFormContent("");
    setFormToolParams(DEFAULT_TOOL_PARAMS);
    setEditingId(null);
    setContentTab("edit");
    setFormPackagePath(null);
    setFormEntryPoint(null);
    setUploadStatus("idle");
  };

  const isFormEditing = editingId !== null;

  const handleSaveSkill = () => {
    if (!formName.trim()) return;
    if (formType === "package" && !formPackagePath) return;
    const patch = {
      name: formName,
      desc: formDesc,
      content: formContent,
      type: formType,
      ...(formType === "tool" ? { toolParameters: formToolParams } : {}),
      ...(formType === "package"
        ? {
            packagePath: formPackagePath,
            entryPoint: formEntryPoint,
            workspaceScope: currentWorkspace || null,
          }
        : {}),
    };
    if (isFormEditing) {
      updateSkill(editingId, patch);
    } else {
      addSkill(patch);
    }
    resetForm();
    setIsAddingSkill(false);
  };

  const handleCancel = () => {
    resetForm();
    setIsAddingSkill(false);
  };

  const handleEditSkill = (skill: any) => {
    setEditingId(skill.id);
    setFormType(skill.type || "instruction");
    setFormName(skill.name);
    setFormDesc(skill.desc);
    setFormContent(skill.content);
    setFormToolParams(skill.toolParameters || DEFAULT_TOOL_PARAMS);
    setFormPackagePath(skill.packagePath || null);
    setFormEntryPoint(skill.entryPoint || null);
    setUploadStatus(skill.packagePath ? "done" : "idle");
    setContentTab("edit");
    setIsAddingSkill(true);
  };

  return isOpen ? (
    <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm">
      <div className="bg-[#09090b] border border-[#27272a] rounded-xl shadow-2xl w-[600px] flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#27272a] flex items-center justify-between bg-[#000000]">
          <h2 className="text-sm font-bold text-white flex items-center gap-2"><IconBook className="w-4 h-4" /> {t.skills}</h2>
          <button onClick={() => { onClose(); handleCancel(); }} className="text-[#a1a1aa] hover:text-white transition-colors"><IconClose className="w-4 h-4" /></button>
        </div>
        <div className="p-6 flex-1 overflow-y-auto max-h-[60vh] bg-[#09090b]">
          {!isAddingSkill ? (
            <>
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
                          <span className="text-[#f59e0b] font-mono mr-1.5">fn:{nameToToolName(skill.name)}</span>
                        )}
                        {skill.desc}
                      </div>
                      {skill.type === "package" && skill.packagePath && (
                        <div className="text-[10px] text-[#60a5fa] mt-1 font-mono">
                          {copy.installedAt} {skill.packagePath}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button onClick={() => handleEditSkill(skill)} className="text-[#a1a1aa] hover:text-[#60a5fa] p-1 opacity-0 group-hover:opacity-100 transition-opacity"><IconEdit className="w-4 h-4" /></button>
                      {!skill.isBuiltIn && (
                        <button onClick={() => deleteSkill(skill.id)} className="text-[#a1a1aa] hover:text-red-400 p-1 opacity-0 group-hover:opacity-100 transition-opacity"><IconTrash className="w-4 h-4" /></button>
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
                      onClick={async () => {
                        try {
                          setUploadStatus("uploading");
                          const selected = await open({
                            multiple: false,
                            filters: [{ name: copy.zipArchives, extensions: ["zip"] }],
                          });
                          if (!selected) {
                            setUploadStatus("idle");
                            return;
                          }
                          const zipPath = typeof selected === "string" ? selected : selected;
                          const result = await invoke<{ name: string; entry_point: string; local_path: string }>("extract_protocol_package", { zipPath });
                          setFormPackagePath(result.local_path);
                          setFormEntryPoint(result.entry_point);
                          if (!formName.trim()) setFormName(result.name);
                          setUploadStatus("done");
                        } catch (err) {
                          console.error("Package upload failed:", err);
                          setUploadStatus("error");
                        }
                      }}
                      disabled={uploadStatus === "uploading"}
                      className="flex items-center gap-2 px-4 py-2 text-[12px] font-bold bg-[#0f1f2e] border border-[#3b82f6] text-[#60a5fa] rounded-md hover:bg-[#1e3a5f] transition-colors disabled:opacity-50"
                    >
                      <IconPackage className="w-3.5 h-3.5" />
                      {uploadStatus === "uploading" ? copy.extracting : copy.uploadZip}
                    </button>
                    {uploadStatus === "done" && formPackagePath && (
                      <span className="text-[11px] text-[#22c55e] font-mono">✓ {formPackagePath}</span>
                    )}
                    {uploadStatus === "error" && (
                      <span className="text-[11px] text-red-400">{copy.uploadFailed}</span>
                    )}
                  </div>
                  <p className="text-[10px] text-[#71717a] mt-1.5">
                    {copy.packageUploadHint}
                  </p>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-[#e4e4e7] mb-2">{copy.description}</label>
                <input type="text" value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder={formType === "tool" ? copy.descPlaceholderTool : copy.descPlaceholderRule} className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[13px] text-white focus:outline-none theme-ring transition-colors" />
              </div>

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
                <button onClick={handleSaveSkill} disabled={!formName.trim() || (formType === "package" && !formPackagePath)} className="flex-1 py-2 text-[12px] theme-bg theme-bg-hover font-bold rounded-md transition-colors disabled:opacity-50">{isFormEditing ? copy.updateSkill : copy.saveSkill}</button>
              </div>
            </div>
          )}
        </div>
        {!isAddingSkill && (<div className="px-6 py-4 border-t border-[#27272a] bg-[#000000] flex justify-end"><button onClick={onClose} className="px-6 py-1.5 theme-bg theme-bg-hover text-[12px] font-bold rounded-md transition-colors shadow-sm">{copy.done}</button></div>)}
      </div>
    </div>
  ) : null;
}
