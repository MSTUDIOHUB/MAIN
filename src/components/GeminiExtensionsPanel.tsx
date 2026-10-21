import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import { parseSkillDocument } from "../lib/agentSkills";
import {
  createGeminiExtensionInstallation,
  normalizeGeminiExtensionWorkspace,
  type GeminiExtensionPreview,
} from "../lib/geminiExtensions";
import { cleanupGeminiExtension, extractGeminiExtension } from "../lib/geminiExtensionIpc";
import { extensionMcpDiscoveryKey } from "../lib/workspaceMcp";

const COPY = {
  zh: {
    title: "Gemini CLI 扩展", import: "导入 Gemini ZIP", update: "更新", cancel: "取消导入",
    install: "安装所选组件", extracting: "读取扩展中…", working: "处理中…", scan: "测试并发现工具",
    remove: "卸载", enabled: "启用扩展", empty: "尚未在此项目安装 Gemini CLI 扩展。",
    scope: "仅在当前项目生效。支持 Skills 和无需认证的 HTTP MCP。", workspace: "请先打开项目文件夹。",
    preview: "导入预览", skills: "Skills", mcp: "HTTP MCP", blocked: "此服务暂不支持",
    unsupported: "以下内容不会生效", noComponents: "没有选择可安装的组件。",
    connection: "已连接", failed: "连接失败", pending: "尚未发现工具", inactive: "已停用",
    failedAction: "操作未完成，请检查扩展包或服务连接后重试。", unsupportedHint: "认证、SSE、stdio、工具过滤和其他配置需要后续适配。",
    installed: "扩展已安装；HTTP MCP 需先测试并发现工具，下一轮任务可用。",
    removed: "扩展已卸载。", duplicate: "此扩展版本已安装。", sameWorkspace: "项目已切换，请在原项目重新导入。",
    busy: "此项目有进行中或暂停的任务，请结束任务后再调整已安装的扩展。",
    invalidPackage: "请检查 ZIP：需要唯一的 gemini-extension.json，以及有效的名称、版本和组件配置。",
    reasons: { headers: "自定义请求头", authentication: "认证", sse: "SSE 传输", stdio: "本机进程", variables: "无效或未配置的地址", filters: "工具限制规则", settings: "安装配置项", timeout: "自定义超时", other: "额外配置" },
    skillConflict: "存在同名 Skill；显式调用时需要消除歧义。", zip: "ZIP 压缩包",
  },
  en: {
    title: "Gemini CLI extensions", import: "Import Gemini ZIP", update: "Update", cancel: "Cancel import",
    install: "Install selected components", extracting: "Reading extension…", working: "Working…", scan: "Test and discover tools",
    remove: "Uninstall", enabled: "Enable extension", empty: "No Gemini CLI extensions installed in this project.",
    scope: "Applies only to this project. Supports Skills and unauthenticated HTTP MCP.", workspace: "Open a project folder first.",
    preview: "Import preview", skills: "Skills", mcp: "HTTP MCP", blocked: "This server is not supported yet",
    unsupported: "These features will not be activated", noComponents: "Select at least one supported component.",
    connection: "Connected", failed: "Connection failed", pending: "Tools not discovered", inactive: "Disabled",
    failedAction: "Could not complete this action. Check the extension package or service connection and try again.", unsupportedHint: "Authentication, SSE, stdio, tool filters, and other configuration require further adaptation.",
    installed: "Extension installed. Test and discover HTTP MCP tools before using them in the next Turn.",
    removed: "Extension uninstalled.", duplicate: "This extension version is already installed.", sameWorkspace: "The project changed. Import again in the original project.",
    busy: "This project has an active or paused task. Finish it before changing installed extensions.",
    invalidPackage: "Check the ZIP: it needs one gemini-extension.json with a valid name, version, and component configuration.",
    reasons: { headers: "custom headers", authentication: "authentication", sse: "SSE transport", stdio: "local process", variables: "invalid or unresolved URL", filters: "tool restrictions", settings: "installation settings", timeout: "custom timeout", other: "additional configuration" },
    skillConflict: "A Skill with the same name exists; explicit invocation must resolve the ambiguity.", zip: "ZIP Archives",
  },
} as const;

const panelStyle = { background: "var(--surface-1, #18181b)", color: "var(--surface-text, #e4e4e7)", borderColor: "var(--surface-border, #27272a)" };
const mutedStyle = { color: "var(--surface-text-muted, #a1a1aa)" };
const actionClass = "rounded-md border px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-50";

export default function GeminiExtensionsPanel({ workspace, language }: { workspace: string; language: "zh" | "en" }) {
  const copy = COPY[language];
  const installations = useAppStore((state) => state.geminiExtensions);
  const discovery = useAppStore((state) => state.extensionMcpDiscovery);
  const skillCatalog = useAppStore((state) => state.resolvedInstructionSet?.skillCatalog);
  const [preview, setPreview] = useState<GeminiExtensionPreview | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [replacingId, setReplacingId] = useState<string | undefined>();
  const [skills, setSkills] = useState<string[]>([]);
  const [mcpKeys, setMcpKeys] = useState<string[]>([]);
  const [skillNames, setSkillNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [isError, setIsError] = useState(false);
  const generation = useRef(0);
  const pending = useRef<GeminiExtensionPreview | null>(null);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const discard = () => {
    const previous = pending.current;
    pending.current = null;
    if (previous) void cleanupGeminiExtension(previous).catch(() => {});
    setPreview(null);
    setSkills([]);
    setMcpKeys([]);
    setSkillNames({});
  };
  useEffect(() => {
    generation.current += 1;
    discard();
    setBusy(false);
    setFeedback("");
    return () => {
      generation.current += 1;
      const previous = pending.current;
      pending.current = null;
      if (previous) void cleanupGeminiExtension(previous).catch(() => {});
    };
  }, [workspace]);

  const showError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setIsError(true);
    setFeedback(/ACTIVE|BUSY|UNRESOLVED|IN_USE|paused|active.*turn/i.test(message) ? copy.busy : /GEMINI_EXTENSION_|manifest|gemini-extension.json/i.test(message) ? copy.invalidPackage : copy.failedAction);
  };
  const blockedReasons = (reasons: readonly string[]) => [...new Set(reasons.map((reason) => {
    if (reason === "headers") return copy.reasons.headers;
    if (/oauth|auth|token|trust/i.test(reason)) return copy.reasons.authentication;
    if (reason === "sse_transport") return copy.reasons.sse;
    if (reason === "stdio_transport") return copy.reasons.stdio;
    if (/url/i.test(reason)) return copy.reasons.variables;
    if (/includeTools|excludeTools|policies/.test(reason)) return copy.reasons.filters;
    if (reason === "settings") return copy.reasons.settings;
    if (reason === "timeout") return copy.reasons.timeout;
    return copy.reasons.other;
  }))].join(" · ");

  const beginImport = async (replace?: string) => {
    if (!workspace || busy) return;
    const owner = workspace;
    const request = ++generation.current;
    discard();
    setFeedback("");
    setBusy(true);
    let extracted: GeminiExtensionPreview | null = null;
    try {
      const path = await open({ multiple: false, filters: [{ name: copy.zip, extensions: ["zip"] }] });
      if (request !== generation.current || !path) return;
      const selected = typeof path === "string" ? path : path[0];
      extracted = await extractGeminiExtension(selected, owner);
      if (request !== generation.current || workspaceRef.current !== owner) {
        await cleanupGeminiExtension(extracted);
        return;
      }
      pending.current = extracted;
      setPreview(extracted);
      setSourcePath(selected);
      setReplacingId(replace);
      setSkills([...extracted.skillEntryPoints]);
      setMcpKeys(extracted.mcpServers.filter((server) => server.supported).map((server) => server.key));
      const names: Record<string, string> = {};
      for (const entry of extracted.skillEntryPoints) {
        const content = await invoke<string>("read_file", { path: `${extracted.packagePath}/${entry}`, workspace: owner });
        names[entry] = parseSkillDocument(content, entry.split("/").slice(-2, -1)[0] || entry, "").name;
      }
      if (request === generation.current) setSkillNames(names);
    } catch (error) {
      if (extracted && pending.current !== extracted) await cleanupGeminiExtension(extracted).catch(() => {});
      if (request === generation.current) showError(error);
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };

  const install = async () => {
    if (!preview || busy || workspaceRef.current !== workspace || (!skills.length && !mcpKeys.length)) return;
    const candidate = preview;
    const owner = workspace;
    const request = generation.current;
    // The operation owns the staged package until the store accepts it. A
    // workspace switch must not delete a package whose commit just completed.
    pending.current = null;
    setBusy(true);
    try {
      const installation = createGeminiExtensionInstallation(candidate, {
        id: replacingId || crypto.randomUUID(), sourcePath, skillEntryPoints: skills, mcpKeys,
      });
      await useAppStore.getState().installGeminiExtension(installation, replacingId);
      const adopted = useAppStore.getState().geminiExtensions.some((item) => item.packagePath === candidate.packagePath && item.workspaceScope === candidate.workspaceScope);
      if (!adopted) await cleanupGeminiExtension(candidate);
      if (request === generation.current && workspaceRef.current === owner) {
        setPreview(null);
        setIsError(false);
        setFeedback(adopted ? copy.installed : copy.duplicate);
      }
    } catch (error) {
      if (request === generation.current && workspaceRef.current === owner) {
        pending.current = candidate;
        showError(error);
      } else {
        await cleanupGeminiExtension(candidate).catch(() => {});
      }
    } finally { if (request === generation.current) setBusy(false); }
  };

  const act = async (action: () => unknown | Promise<unknown>, success = "") => {
    const request = ++generation.current;
    const owner = workspace;
    setBusy(true);
    setFeedback("");
    try {
      await action();
      if (request === generation.current && workspaceRef.current === owner) {
        setIsError(false);
        if (success) setFeedback(success);
      }
    } catch (error) {
      if (request === generation.current && workspaceRef.current === owner) showError(error);
    } finally {
      if (request === generation.current && workspaceRef.current === owner) setBusy(false);
    }
  };
  const toggleSelection = (list: string[], key: string) => list.includes(key) ? list.filter((item) => item !== key) : [...list, key];
  const installedHere = (installations || []).filter((item) => normalizeGeminiExtensionWorkspace(item.workspaceScope) === normalizeGeminiExtensionWorkspace(workspace));

  return <section data-testid="gemini-extensions-panel" className="mb-5 rounded-lg border p-4 space-y-3" style={panelStyle}>
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-xs font-bold">{copy.title}</h3>
      <button type="button" className={actionClass} style={panelStyle} disabled={!workspace || busy} onClick={() => void beginImport()}>{busy ? copy.working : copy.import}</button>
    </div>
    <p className="text-[11px] leading-relaxed" style={mutedStyle}>{workspace ? copy.scope : copy.workspace}</p>
    {feedback && <p role={isError ? "alert" : "status"} className="text-[11px] leading-relaxed">{feedback}</p>}
    {preview && <div className="rounded-md border p-3 space-y-3" style={panelStyle} data-testid="gemini-extension-preview">
      <p className="text-xs font-bold">{copy.preview}: {preview.name} · {preview.version}</p>
      {preview.description && <p className="text-[11px]" style={mutedStyle}>{preview.description}</p>}
      {preview.skillEntryPoints.length > 0 && <fieldset className="space-y-2">
        <legend className="text-[11px] font-bold mb-2">{copy.skills}</legend>
        {preview.skillEntryPoints.map((entry) => <label key={entry} className="flex items-start gap-2 text-[11px]">
          <input type="checkbox" checked={skills.includes(entry)} onChange={() => setSkills(toggleSelection(skills, entry))} disabled={busy} />
          <span className="break-all">{skillNames[entry] || entry}<span className="block" style={mutedStyle}>{entry}</span></span>
        </label>)}
        {Object.values(skillNames).some((name) => skillCatalog?.entries.some((entry) => entry.name === name && (!replacingId || !entry.id.startsWith(`package:gemini:${replacingId}`)))) && <p className="text-[11px]" role="status" style={mutedStyle}>{copy.skillConflict}</p>}
      </fieldset>}
      {preview.mcpServers.length > 0 && <fieldset className="space-y-2">
        <legend className="text-[11px] font-bold mb-2">{copy.mcp}</legend>
        {preview.mcpServers.map((server) => <label key={server.key} className="flex items-start gap-2 text-[11px]">
          <input type="checkbox" checked={mcpKeys.includes(server.key)} disabled={busy || !server.supported} onChange={() => setMcpKeys(toggleSelection(mcpKeys, server.key))} />
          <span className="break-all">{server.key}{server.supported ? <span className="block" style={mutedStyle}>{server.url}</span> : <span className="block" style={mutedStyle}>{copy.blocked}: {blockedReasons(server.reasons)}.</span>}</span>
        </label>)}
      </fieldset>}
      {preview.unsupportedFeatures.length > 0 && <p className="text-[11px] leading-relaxed" style={mutedStyle}>{copy.unsupported}: {preview.unsupportedFeatures.join(", ")}</p>}
      <div className="flex gap-2">
        <button type="button" className={actionClass} style={panelStyle} disabled={busy} onClick={() => { ++generation.current; discard(); }}>{copy.cancel}</button>
        <button type="button" className={`${actionClass} theme-bg theme-bg-hover`} disabled={busy || (!skills.length && !mcpKeys.length)} onClick={() => void install()}>{copy.install}</button>
      </div>
    </div>}
    {!preview && installedHere.length === 0 && <p className="text-[11px]" style={mutedStyle}>{copy.empty}</p>}
    {installedHere.map((installation) => <div key={installation.id} className="rounded-md border p-3 space-y-2" style={panelStyle} data-testid="gemini-extension-installation">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{installation.name} · {installation.version}</span>
        <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" aria-label={`${copy.enabled}: ${installation.name}`} checked={installation.enabled} disabled={busy} onChange={(event) => void act(() => useAppStore.getState().setGeminiExtensionEnabled(installation.id, event.target.checked))} />{copy.enabled}</label>
      </div>
      <p className="text-[11px]" style={mutedStyle}>{copy.skills}: {installation.skillEntryPoints.length} · {copy.mcp}: {installation.mcpServers.filter((server) => server.supported && server.enabled).length}</p>
      {installation.skillEntryPoints.length > 0 && <ul className="text-[11px] space-y-1" style={mutedStyle}>{installation.skillEntryPoints.map((entry) => <li className="break-all" key={entry}>{entry}</li>)}</ul>}
      {installation.unsupportedFeatures.length > 0 && <p className="text-[11px] break-words" style={mutedStyle}>{copy.unsupported}: {installation.unsupportedFeatures.join(", ")}</p>}
      {installation.mcpServers.filter((server) => !server.supported).map((server) => <p key={server.key} className="text-[11px]" style={mutedStyle}>{server.key} · {copy.blocked}: {blockedReasons(server.reasons)}</p>)}
      {installation.mcpServers.filter((server) => server.supported && server.enabled).map((server) => {
        const matching = discovery?.[extensionMcpDiscoveryKey(installation)]?.serverStatuses.find((status) => status.serverName === `gemini:${installation.id}:${server.key}`);
        const state = matching?.status;
        return <p key={server.key} className="text-[11px]" style={mutedStyle}>{server.key} · {!installation.enabled ? copy.inactive : state === "connected" ? copy.connection : state === "failed" ? copy.failed : copy.pending}</p>;
      })}
      <div className="flex flex-wrap gap-2">
        {installation.mcpServers.some((server) => server.supported && server.enabled) && <button type="button" className={actionClass} style={panelStyle} disabled={busy || !installation.enabled} onClick={() => void act(() => useAppStore.getState().scanGeminiExtensionMcp(installation.id))}>{copy.scan}</button>}
        <button type="button" className={actionClass} style={panelStyle} disabled={busy} onClick={() => void beginImport(installation.id)}>{copy.update}</button>
        <button type="button" className={actionClass} style={panelStyle} disabled={busy} onClick={() => void act(() => useAppStore.getState().removeGeminiExtension(installation.id), copy.removed)}>{copy.remove}</button>
      </div>
    </div>)}
  </section>;
}
